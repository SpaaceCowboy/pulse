import { createServer } from 'node:http'
import { loadTargets } from '@pulse/core'
import { createDb } from '@pulse/db'
import { Redis } from 'ioredis'

const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

const { targets } = loadTargets(process.env.TARGETS_FILE ?? 'targets.yaml')
const { pool } = createDb(env('DATABASE_URL'))
const redis = new Redis(env('REDIS_URL'), { maxRetriesPerRequest: 2 })

// Phase 0: no scheduler or checkers yet (Phase 1). Only prove config + deps are reachable.
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
  console.log(`worker idle: ${targets.length} targets loaded, /healthz up`)
})
