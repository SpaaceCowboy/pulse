import 'server-only'
import { Redis } from 'ioredis'
import { createDb } from '@pulse/db'

// One pool / connection per server process, kept across Next dev reloads.
const g = globalThis as unknown as {
  __pulseDb?: ReturnType<typeof createDb>
  __pulseRedis?: Redis
}

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

export function getDb() {
  g.__pulseDb ??= createDb(need('DATABASE_URL'))
  return g.__pulseDb.db
}

export function getRedis(): Redis {
  g.__pulseRedis ??= new Redis(need('REDIS_URL'), { maxRetriesPerRequest: 2 })
  return g.__pulseRedis
}
