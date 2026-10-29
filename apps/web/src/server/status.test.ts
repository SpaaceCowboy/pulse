// Integration: the scope contract on real Postgres + Redis (`pnpm test:db`); skipped otherwise.
// A USER must never receive an audience=admin target in any status.ts output, not even as a string.
import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDb, migrateUp, syncTargets, TEST_DATABASE_URL } from '@pulse/db'

const REDIS_URL = process.env.TEST_REDIS_URL
const ctx = vi.hoisted(() => ({ db: undefined as unknown, redis: undefined as unknown }))
vi.mock('./runtime', () => ({ getDb: () => ctx.db, getRedis: () => ctx.redis }))

const tag = randomBytes(3).toString('hex')
const ROCO = `leak-roco-${tag}`
const ADMIN = `leak-admin-${tag}`
const SECRET_NAME = `Admin Only Proxy ${tag}`
const SECRET_MSG = `xray-secret-failure-${tag}`

describe.skipIf(!TEST_DATABASE_URL || !REDIS_URL)('status.ts scoping', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  let redis: Redis
  let status: typeof import('./status')
  const keys: string[] = []

  beforeAll(async () => {
    t = await createTestDb()
    await migrateUp(t.pool)
    redis = new Redis(REDIS_URL!)
    ctx.db = t.db
    ctx.redis = redis
    status = await import('./status')

    const mk = (id: string, name: string, audience: 'roco' | 'admin') => ({
      id,
      name,
      group: audience === 'roco' ? 'Roco Broker' : 'Personal & client projects',
      audience,
      tags: [],
      env: 'production',
      checks: [{ id: `${id}:0:http`, kind: 'http', config: {}, intervalS: 60, timeoutMs: 5000, vantage: ['core'] }],
    })
    await syncTargets(t.db, [mk(ROCO, 'Roco Site', 'roco'), mk(ADMIN, SECRET_NAME, 'admin')])

    for (const id of [ROCO, ADMIN]) {
      const key = `pulse:state:${id}:0:http`
      keys.push(key)
      const bad = id === ADMIN
      await redis.set(
        key,
        JSON.stringify({
          state: { phase: bad ? 'down' : 'up', fails: 0, passes: 0, degradedSince: null, degradedSustained: false, changedAt: 1 },
          last: { status: bad ? 'down' : 'up', ts: Date.now(), latencyMs: 50, message: bad ? SECRET_MSG : 'ok' },
        }),
      )
      await t.pool.query(
        "INSERT INTO check_results (check_id, vantage, ts, status, latency_ms, message) VALUES ($1,'core',now(),$2,50,$3)",
        [`${id}:0:http`, bad ? 'down' : 'up', bad ? SECRET_MSG : 'ok'],
      )
      await t.pool.query("INSERT INTO incidents (check_id, opened_at, cause, last_message) VALUES ($1, now(), $2, $2)", [
        `${id}:0:http`,
        bad ? SECRET_MSG : 'roco blip',
      ])
    }
  })
  afterAll(async () => {
    if (keys.length) await redis.del(...keys)
    redis.disconnect()
    await t.drop()
  })

  const user = { role: 'USER' as const }
  const admin = { role: 'ADMIN' as const }
  const leaks = (s: string) => [ADMIN, SECRET_NAME, SECRET_MSG, 'Personal & client'].filter((x) => s.includes(x))

  it('USER snapshot has only the roco target, and no admin string anywhere in the JSON', async () => {
    const snap = await status.getSnapshot(user)
    expect(snap.targets.map((x) => x.id)).toEqual([ROCO])
    expect(snap.summary).toMatchObject({ up: 1, down: 0, openIncidents: 1 })
    expect(leaks(JSON.stringify(snap))).toEqual([])
  })

  it('ADMIN snapshot has both, admin down first', async () => {
    const snap = await status.getSnapshot(admin)
    expect(snap.targets.map((x) => x.id)).toEqual([ADMIN, ROCO])
    expect(snap.summary).toMatchObject({ up: 1, down: 1, openIncidents: 2 })
  })

  it('detail: admin target is null for USER (same as a missing id), present for ADMIN', async () => {
    expect(await status.getTargetDetail(user, ADMIN)).toBeNull()
    expect(await status.getTargetDetail(user, 'does-not-exist')).toBeNull()
    expect(leaks(JSON.stringify(await status.getTargetDetail(user, ROCO)))).toEqual([])
    const d = await status.getTargetDetail(admin, ADMIN)
    expect(d?.target.status).toBe('down')
    expect(d?.results[`${ADMIN}:0:http`]).toHaveLength(1)
  })

  it('incidents are scoped', async () => {
    const mine = await status.listIncidents(user)
    expect(mine.map((i) => i.targetId)).toEqual([ROCO])
    expect(leaks(JSON.stringify(mine))).toEqual([])
    expect((await status.listIncidents(admin)).map((i) => i.targetId).sort()).toEqual([ADMIN, ROCO].sort())
  })

  it('fails closed for a missing viewer or unknown role', async () => {
    expect((await status.getSnapshot(null as never)).targets).toEqual([])
    expect((await status.getSnapshot({ role: 'GUEST' } as never)).targets).toEqual([])
    expect(await status.getTargetDetail({ role: 'GUEST' } as never, ROCO)).toBeNull()
    expect(await status.listIncidents(null as never)).toEqual([])
  })
})
