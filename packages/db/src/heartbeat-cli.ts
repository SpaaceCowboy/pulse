// Heartbeat tokens. The token is the secret in the push URL, shown once; only its SHA-256 is stored.
//   pnpm heartbeat create <checkId>   (also rotates: the old URL stops working)
//   pnpm heartbeat list
import { randomBytes } from 'node:crypto'
import { checkExists, listHeartbeats, sha256, upsertHeartbeat } from './alerts'
import { createDb } from './client'

export const HEARTBEAT_TOKEN_PREFIX = 'hb_'
const DEFAULT_GRACE_S = 3600

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

const [cmd, checkId] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const url = process.env.DATABASE_URL
if (!url) fail('missing env DATABASE_URL')
const { db, pool } = createDb(url)

try {
  if (cmd === 'list') {
    for (const h of await listHeartbeats(db)) {
      console.log(`${h.checkId}\tgrace:${h.graceS}s\tlast:${h.lastPingAt?.toISOString() ?? 'never'}\t${h.lastStatus ?? '-'}`)
    }
  } else if (cmd === 'create') {
    if (!checkId) fail('usage: heartbeat create <checkId>   (ids look like roco-seo:0:heartbeat)')
    const check = await checkExists(db, checkId)
    if (!check) fail(`unknown check ${checkId} (the worker syncs targets.yaml on boot)`)
    if (check.kind !== 'heartbeat') fail(`${checkId} is a ${check.kind} check, not a heartbeat`)
    const grace = Number((check.config as { grace_s?: unknown })?.grace_s)
    const token = HEARTBEAT_TOKEN_PREFIX + randomBytes(24).toString('base64url')
    await upsertHeartbeat(db, checkId, sha256(token), Number.isFinite(grace) && grace > 0 ? grace : DEFAULT_GRACE_S)
    const base = (process.env.PUBLIC_URL ?? 'https://pulse.example.com').replace(/\/$/, '')
    console.log(`push URL (shown once):\n  curl -fsS -X POST ${base}/api/push/${token}\n  failure: ... /api/push/${token}?status=fail`)
  } else {
    fail('usage: heartbeat create <checkId> | heartbeat list')
  }
} finally {
  await pool.end()
}
