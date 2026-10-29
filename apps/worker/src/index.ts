import { createServer } from 'node:http'
import { loadTargets } from '@pulse/core'
import { createDb } from '@pulse/db'
import { Redis } from 'ioredis'
import { startScheduler } from './scheduler'

const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

const { targets } = loadTargets(process.env.TARGETS_FILE ?? 'targets.yaml')
const { pool } = createDb(env('DATABASE_URL'))
const redis = new Redis(env('REDIS_URL'), { maxRetriesPerRequest: 2 })

// Phase 1: scheduler runs checks and logs results (storage/state machine arrive in Phase 2).
// BullMQ needs its own connection with maxRetriesPerRequest: null.
if (process.env.SCHEDULER_ENABLED !== 'false') {
  const scheduler = await startScheduler({
    connection: new Redis(env('REDIS_URL'), { maxRetriesPerRequest: null }),
    targets,
    onResult: (ref, r) =>
      console.log(JSON.stringify({ check: ref.id, status: r.status, latencyMs: r.latencyMs, message: r.message })),
  })
  console.log(`scheduler: ${scheduler.checks} checks scheduled`)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void scheduler.close().then(() => process.exit(0)))
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
