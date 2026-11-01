// Machine-authenticated writes: heartbeat pushes (secret token in the URL) and probe batches (HMAC-signed).
// These routes have no viewer; they can only append results / pings, never read targets back.
import 'server-only'
import { MAX_BODY_BYTES, probeBatchSchema, verifyIngest } from '@pulse/core'
import { insertResult, pingHeartbeat, sha256, sql } from '@pulse/db'
import { getDb, getRedis } from './runtime'

const VANTAGE_PREFIX = 'pulse:vantage:'
const RESERVED_VANTAGES = new Set(['core', 'push'])
const MAX_RESULT_AGE_MS = 5 * 60_000
const MAX_FUTURE_MS = 60_000

export type IngestOutcome =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 401 | 404 | 413 | 429 | 503; body: { error: string } }

/** Fixed-window counter. Fails open (Redis down must not stop heartbeats); signatures/tokens still gate. */
async function limited(key: string, max: number, windowS: number): Promise<boolean> {
  try {
    const r = getRedis()
    const k = `pulse:rl:${key}`
    const n = await r.incr(k)
    if (n === 1) await r.expire(k, windowS)
    return n > max
  } catch {
    return false
  }
}

/** POST /api/push/:token. Unknown tokens get a plain 404, same as a missing route. */
export async function acceptPush(
  token: string,
  ping: { ok: boolean; message?: string },
  ip: string,
  now = new Date(),
): Promise<IngestOutcome> {
  if (await limited(`push:${ip}`, 120, 60)) return { status: 429, body: { error: 'rate limited' } }
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { status: 404, body: { error: 'not found' } }
  const checkId = await pingHeartbeat(getDb(), sha256(token), ping, now)
  if (!checkId) return { status: 404, body: { error: 'not found' } }
  return { status: 200, body: { ok: true } }
}

/** POST /api/ingest from a probe vantage. */
export async function acceptProbeBatch(
  raw: string,
  headers: { timestamp: string | null; nonce: string | null; signature: string | null },
  ip: string,
  now = Date.now(),
): Promise<IngestOutcome> {
  if (raw.length > MAX_BODY_BYTES) return { status: 413, body: { error: 'too large' } }
  if (await limited(`ingest:${ip}`, 300, 60)) return { status: 429, body: { error: 'rate limited' } }
  const secret = process.env.HMAC_INGEST_SECRET
  if (!secret) return { status: 503, body: { error: 'ingest not configured' } }

  const v = verifyIngest(secret, raw, headers, now)
  if (!v.ok) {
    console.warn(`ingest rejected from ${ip}: ${v.reason}`)
    return { status: 401, body: { error: 'unauthorized' } }
  }
  // replay protection: each nonce is accepted once within the skew window (plus margin). Fail closed.
  try {
    const first = await getRedis().set(`pulse:nonce:${v.nonce}`, '1', 'EX', 180, 'NX')
    if (first !== 'OK') {
      console.warn(`ingest replay from ${ip}`)
      return { status: 401, body: { error: 'unauthorized' } }
    }
  } catch {
    return { status: 503, body: { error: 'unavailable' } }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { status: 400, body: { error: 'invalid json' } }
  }
  const parsed = probeBatchSchema.safeParse(json)
  if (!parsed.success) return { status: 400, body: { error: 'invalid batch' } }
  const { vantage, results } = parsed.data
  if (RESERVED_VANTAGES.has(vantage)) return { status: 400, body: { error: 'reserved vantage' } }

  const db = getDb()
  const ids = [...new Set(results.map((r) => r.checkId))]
  const idArray = sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::text[]`
  const known = await db.execute<{ id: string; vantage: string[] }>(sql`SELECT id, vantage FROM checks WHERE id = ANY(${idArray})`)
  const allowed = new Set(known.rows.filter((r) => r.vantage.includes(vantage)).map((r) => r.id))

  const redis = getRedis()
  let accepted = 0
  for (const r of results) {
    if (!allowed.has(r.checkId) || r.ts < now - MAX_RESULT_AGE_MS || r.ts > now + MAX_FUTURE_MS) continue
    await insertResult(db, {
      checkId: r.checkId,
      vantage,
      ts: new Date(r.ts),
      status: r.status,
      latencyMs: r.latencyMs,
      message: r.message,
    })
    const key = VANTAGE_PREFIX + r.checkId
    await redis
      .multi()
      .hset(key, vantage, JSON.stringify({ status: r.status, ts: r.ts, message: r.message }))
      .expire(key, 86_400)
      .exec()
    accepted++
  }
  return { status: 200, body: { accepted, rejected: results.length - accepted } }
}
