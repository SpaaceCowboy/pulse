// Integration tests: need TEST_DATABASE_URL and TEST_REDIS_URL (`pnpm test:db`); skipped otherwise.
import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, migrateUp, TEST_DATABASE_URL } from '@pulse/db'
import type { CheckResult } from '@pulse/core'
import { recordResult } from './record'
import { StateStore } from './state-store'

const REDIS_URL = process.env.TEST_REDIS_URL

describe.skipIf(!TEST_DATABASE_URL || !REDIS_URL)('recordResult', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  let redis: Redis
  let store: StateStore
  const prefix = `test:${randomBytes(4).toString('hex')}:`

  beforeAll(async () => {
    t = await createTestDb()
    await migrateUp(t.pool)
    redis = new Redis(REDIS_URL!)
    store = new StateStore(redis, prefix)
  })
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`)
    if (keys.length) await redis.del(...keys)
    redis.disconnect()
    await t.drop()
  })

  const T0 = Date.parse('2026-10-29T10:00:00Z')
  const at = (i: number) => new Date(T0 + i * 60_000)
  const up: CheckResult = { status: 'up', latencyMs: 40 }
  const down: CheckResult = { status: 'down', message: 'HTTP 500' }
  const incidentsOf = async (id: string) =>
    (await t.pool.query('SELECT opened_at, resolved_at, cause FROM incidents WHERE check_id = $1 ORDER BY id', [id])).rows

  it('fail, fail, fail, pass, pass opens exactly one incident and resolves it', async () => {
    const id = 'site:0:http'
    const seq = [down, down, down, up, up]
    for (const [i, r] of seq.entries()) {
      await recordResult({ db: t.db, store }, id, r, at(i))
      const rows = await incidentsOf(id)
      if (i < 2) expect(rows).toHaveLength(0)
      else if (i < 4) {
        expect(rows).toHaveLength(1)
        expect(rows[0].resolved_at).toBeNull()
      }
    }
    const rows = await incidentsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].opened_at.toISOString()).toBe(at(2).toISOString())
    expect(rows[0].resolved_at.toISOString()).toBe(at(4).toISOString())
    expect(rows[0].cause).toBe('HTTP 500')

    const n = await t.pool.query('SELECT count(*)::int AS n FROM check_results WHERE check_id = $1', [id])
    expect(n.rows[0].n).toBe(5)
    const stored = await store.get(id)
    expect(stored?.state.phase).toBe('up')
    expect(stored?.last).toMatchObject({ status: 'up', ts: at(4).getTime() })
  })

  it('degraded results never open an incident', async () => {
    const id = 'site:1:domain'
    for (let i = 0; i < 6; i++) await recordResult({ db: t.db, store }, id, { status: 'degraded', message: 'expiry unknown' }, at(i))
    expect(await incidentsOf(id)).toHaveLength(0)
  })

  it('keeps counting across a restart (state comes back from Redis)', async () => {
    const id = 'site:2:tcp'
    await recordResult({ db: t.db, store }, id, down, at(0))
    await recordResult({ db: t.db, store }, id, down, at(1))
    const reopened = new StateStore(new Redis(REDIS_URL!), prefix) // fresh store instance, same Redis
    await recordResult({ db: t.db, store: reopened }, id, down, at(2))
    expect(await incidentsOf(id)).toHaveLength(1)
  })

  it('rebuilds as down from the open incident when the Redis key is lost', async () => {
    const id = 'site:3:http'
    for (let i = 0; i < 3; i++) await recordResult({ db: t.db, store }, id, down, at(i))
    await redis.del(`${prefix}${id}`)

    // still down after the wipe: no duplicate incident
    await recordResult({ db: t.db, store }, id, down, at(3))
    expect(await incidentsOf(id)).toHaveLength(1)

    // recovery after the wipe still resolves the original incident
    await redis.del(`${prefix}${id}`)
    await recordResult({ db: t.db, store }, id, up, at(4))
    await recordResult({ db: t.db, store }, id, up, at(5))
    const rows = await incidentsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].resolved_at).not.toBeNull()
  })

  it('two flapping outages make two incidents', async () => {
    const id = 'site:4:http'
    const seq = [down, down, down, up, up, down, down, down, up, up]
    for (const [i, r] of seq.entries()) await recordResult({ db: t.db, store }, id, r, at(i))
    const rows = await incidentsOf(id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.resolved_at)).toBe(true)
  })
})
