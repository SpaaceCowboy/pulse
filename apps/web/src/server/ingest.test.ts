// Integration: heartbeat push + HMAC probe ingest on real Postgres + Redis (`pnpm test:db`); skipped otherwise.
import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDb, migrateUp, sha256, syncTargets, TEST_DATABASE_URL, upsertHeartbeat } from '@pulse/db'
import { H_NONCE, H_SIGNATURE, H_TIMESTAMP, signIngest, SKEW_MS } from '@pulse/core'

const REDIS_URL = process.env.TEST_REDIS_URL
const ctx = vi.hoisted(() => ({ db: undefined as unknown, redis: undefined as unknown }))
vi.mock('./runtime', () => ({ getDb: () => ctx.db, getRedis: () => ctx.redis }))

const tag = randomBytes(3).toString('hex')
const SECRET = `test-secret-${tag}-0123456789abcdef`
const TWO = `two-${tag}:0:http` // core + hostvds
const ONE = `one-${tag}:0:http` // core only

describe.skipIf(!TEST_DATABASE_URL || !REDIS_URL)('ingest', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  let redis: Redis
  let ing: typeof import('./ingest')
  const keys: string[] = []
  let ipN = 0
  const ip = () => `10.9.${tag.length}.${++ipN}-${tag}`

  beforeAll(async () => {
    process.env.HMAC_INGEST_SECRET = SECRET
    t = await createTestDb()
    await migrateUp(t.pool)
    redis = new Redis(REDIS_URL!)
    ctx.db = t.db
    ctx.redis = redis
    ing = await import('./ingest')
    const mk = (id: string, checkId: string, vantage: string[]) => ({
      id,
      name: id,
      group: 'g',
      audience: 'roco' as const,
      tags: [],
      env: 'production',
      checks: [{ id: checkId, kind: 'http', config: {}, intervalS: 60, timeoutMs: 5000, vantage }],
    })
    await syncTargets(t.db, [mk(`two-${tag}`, TWO, ['core', 'hostvds']), mk(`one-${tag}`, ONE, ['core'])])
  })

  afterAll(async () => {
    await redis.del(...keys)
    redis.disconnect()
    await t.drop()
  })

  const batch = (results: unknown[], vantage = 'hostvds') => JSON.stringify({ vantage, results })
  const hdr = (h: Record<string, string>) => ({ timestamp: h[H_TIMESTAMP]!, nonce: h[H_NONCE]!, signature: h[H_SIGNATURE]! })
  const send = (body: string, h = hdr(signIngest(SECRET, body)), from = ip()) => ing.acceptProbeBatch(body, h, from)
  const rows = async (checkId: string) => (await t.pool.query('SELECT vantage, status FROM check_results WHERE check_id = $1', [checkId])).rows

  it('accepts a signed batch, stores the rows, and publishes the freshest result per vantage', async () => {
    const now = Date.now()
    const out = await send(batch([{ checkId: TWO, ts: now, status: 'down', latencyMs: 12, message: 'timeout' }]))
    expect(out).toEqual({ status: 200, body: { accepted: 1, rejected: 0 } })
    expect(await rows(TWO)).toEqual([{ vantage: 'hostvds', status: 'down' }])
    keys.push(`pulse:vantage:${TWO}`)
    const entry = JSON.parse((await redis.hget(`pulse:vantage:${TWO}`, 'hostvds'))!)
    expect(entry).toMatchObject({ status: 'down', message: 'timeout', ts: now })
  })

  it('rejects a bad signature, a tampered body, and a missing secret header', async () => {
    const body = batch([{ checkId: TWO, ts: Date.now(), status: 'up' }])
    const good = hdr(signIngest(SECRET, body))
    expect((await send(body, { ...good, signature: 'v1=' + '0'.repeat(64) })).status).toBe(401)
    expect((await send(body + ' ', good)).status).toBe(401)
    expect((await send(body, hdr(signIngest('another-secret-another-secret-aa', body)))).status).toBe(401)
    expect((await ing.acceptProbeBatch(body, { timestamp: null, nonce: null, signature: null }, ip())).status).toBe(401)
  })

  it('rejects a replay of an already-accepted request', async () => {
    const body = batch([{ checkId: TWO, ts: Date.now(), status: 'up' }])
    const h = hdr(signIngest(SECRET, body))
    expect((await send(body, h)).status).toBe(200)
    keys.push(`pulse:nonce:${h.nonce}`)
    const before = (await rows(TWO)).length
    expect((await send(body, h)).status).toBe(401)
    expect((await rows(TWO)).length).toBe(before)
  })

  it('rejects an old or future timestamp even with a valid signature (replay window)', async () => {
    const body = batch([{ checkId: TWO, ts: Date.now(), status: 'up' }])
    expect((await send(body, hdr(signIngest(SECRET, body, Date.now() - SKEW_MS - 5000)))).status).toBe(401)
    expect((await send(body, hdr(signIngest(SECRET, body, Date.now() + SKEW_MS + 5000)))).status).toBe(401)
  })

  it('only stores results for checks that list the sending vantage, with sane timestamps', async () => {
    const now = Date.now()
    const out = await send(
      batch([
        { checkId: ONE, ts: now, status: 'down' }, // core-only check: hostvds is not a voter
        { checkId: 'nope:0:http', ts: now, status: 'down' }, // unknown check
        { checkId: TWO, ts: now - 10 * 60_000, status: 'down' }, // too old
        { checkId: TWO, ts: now + 5 * 60_000, status: 'down' }, // from the future
        { checkId: TWO, ts: now, status: 'up' }, // fine
      ]),
    )
    expect(out).toEqual({ status: 200, body: { accepted: 1, rejected: 4 } })
    expect(await rows(ONE)).toEqual([])
  })

  it('refuses vantages that would impersonate the core or heartbeats, malformed JSON and oversized bodies', async () => {
    const ts = Date.now()
    expect((await send(batch([{ checkId: TWO, ts, status: 'down' }], 'core'))).status).toBe(400)
    expect((await send(batch([{ checkId: TWO, ts, status: 'down' }], 'push'))).status).toBe(400)
    expect((await send('not json')).status).toBe(400)
    expect((await send(JSON.stringify({ vantage: 'hostvds', results: [{ checkId: TWO, ts, status: 'up', extra: 1 }] }))).status).toBe(400)
    expect((await send('x'.repeat(70_000))).status).toBe(413)
  })

  it('is rate limited per client address', async () => {
    const from = ip()
    let last = 0
    for (let i = 0; i < 305; i++) last = (await ing.acceptProbeBatch('{}', { timestamp: null, nonce: null, signature: null }, from)).status
    expect(last).toBe(429)
    keys.push(`pulse:rl:ingest:${from}`)
  })

  describe('heartbeat push', () => {
    const token = `hb_${randomBytes(18).toString('base64url')}`
    const checkId = `one-${tag}:7:heartbeat`
    beforeAll(async () => {
      await t.pool.query("INSERT INTO checks (id, target_id, kind, config, interval_s, timeout_ms, vantage) VALUES ($1,$2,'heartbeat','{}',60,5000,'{push}')", [checkId, `one-${tag}`])
      await upsertHeartbeat(t.db, checkId, sha256(token), 600)
    })
    const state = async () => (await t.pool.query('SELECT last_status, last_message, last_ping_at FROM heartbeats WHERE check_id = $1', [checkId])).rows[0]

    it('a valid token records the ping; ?status=fail records a failure with its message', async () => {
      expect((await ing.acceptPush(token, { ok: true }, ip())).status).toBe(200)
      expect(await state()).toMatchObject({ last_status: 'ok' })
      expect((await ing.acceptPush(token, { ok: false, message: 'exit 2' }, ip())).status).toBe(200)
      expect(await state()).toMatchObject({ last_status: 'fail', last_message: 'exit 2' })
    })

    it('unknown, malformed and hash-as-token requests all get the same 404', async () => {
      for (const bad of [`hb_${randomBytes(18).toString('base64url')}`, 'short', 'x'.repeat(30) + '!', sha256(token)]) {
        expect(await ing.acceptPush(bad, { ok: true }, ip()), bad).toEqual({ status: 404, body: { error: 'not found' } })
      }
    })

    it('is rate limited per address', async () => {
      const from = ip()
      let last = 0
      for (let i = 0; i < 125; i++) last = (await ing.acceptPush('x'.repeat(30), { ok: true }, from)).status
      expect(last).toBe(429)
      keys.push(`pulse:rl:push:${from}`)
    })
  })
})
