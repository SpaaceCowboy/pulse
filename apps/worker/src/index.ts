import { createServer } from 'node:http'
import { loadTargets } from '@pulse/core'
import { createDb, migrateUp, syncTargets } from '@pulse/db'
import { Redis } from 'ioredis'
import { startMaintenance } from './maintenance'
import { LOCAL_VANTAGE, recordResult } from './record'
import { isPlaceholder, listChecks } from './run-check'
import { startScheduler } from './scheduler'
import { StateStore } from './state-store'

const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

const { targets } = loadTargets(process.env.TARGETS_FILE ?? 'targets.yaml')
const { db, pool } = createDb(env('DATABASE_URL'))
const redis = new Redis(env('REDIS_URL'), { maxRetriesPerRequest: 2 })

const applied = await migrateUp(pool)
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`)

// Checks against placeholder hosts (*.example) are still run and logged but never stored,
// so they cannot open incidents.
const stored = new Set(
  listChecks(targets)
    .filter((r) => !isPlaceholder(r))
    .map((r) => r.id),
)
await syncTargets(
  db,
  targets.map((t) => ({
    id: t.id,
    name: t.name,
    group: t.group,
    audience: t.audience,
    tags: t.tags,
    env: t.env,
    checks: listChecks([t])
      .filter((r) => stored.has(r.id))
      .map((r) => ({
        id: r.id,
        kind: r.check.kind,
        config: r.check.config,
        intervalS: r.intervalS,
        timeoutMs: r.timeoutMs,
        vantage: r.check.vantage ?? [LOCAL_VANTAGE],
      })),
  })),
)

// BullMQ needs its own connection with maxRetriesPerRequest: null.
if (process.env.SCHEDULER_ENABLED !== 'false') {
  const store = new StateStore(redis)
  const log = (msg: string) => console.log(msg)
  const maintenance = await startMaintenance({
    connection: new Redis(env('REDIS_URL'), { maxRetriesPerRequest: null }),
    db,
    log,
  })
  const scheduler = await startScheduler({
    connection: new Redis(env('REDIS_URL'), { maxRetriesPerRequest: null }),
    targets,
    onResult: async (ref, r) => {
      console.log(JSON.stringify({ check: ref.id, status: r.status, latencyMs: r.latencyMs, message: r.message }))
      if (stored.has(ref.id)) await recordResult({ db, store, log }, ref.id, r)
    },
  })
  console.log(`scheduler: ${scheduler.checks} checks scheduled, ${stored.size} stored`)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => void Promise.all([scheduler.close(), maintenance.close()]).then(() => process.exit(0)))
  }
}

createServer(async (req, res) => {
  if (req.url !== '/healthz') {
    res.writeHead(404).end()
    return
  }
  try {
    await Promise.all([pool.query('select 1'), redis.ping()])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', targets: targets.length }))
  } catch (err) {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'down', error: String(err) }))
  }
}).listen(Number(process.env.PORT ?? 3001), () => {
  console.log(`worker: ${targets.length} targets loaded, /healthz up`)
})
