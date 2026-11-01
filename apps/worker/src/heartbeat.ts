// Heartbeat checks are passive: cron jobs and workers POST /api/push/:token. This evaluator turns the stored ping
// state into ordinary check results, so silence flows through the same 3-fail / 2-pass state machine as any check.
import type { CheckResult } from '@pulse/core'
import { listHeartbeats, type Db, type HeartbeatRow } from '@pulse/db'
import { formatDuration } from './alerts/duration'
import { recordResult, type RecordDeps } from './record'

export const HEARTBEAT_VANTAGE = 'push'
export const HEARTBEAT_INTERVAL_MS = 60_000

/** null = nothing to say yet (token created, still inside the first grace period). */
export function heartbeatResult(h: HeartbeatRow, now: number): CheckResult | null {
  const grace = h.graceS * 1000
  if (!h.lastPingAt) {
    return now - h.createdAt.getTime() > grace
      ? { status: 'down', message: `no ping received within ${formatDuration(grace)} of creation` }
      : null
  }
  const age = now - h.lastPingAt.getTime()
  if (h.lastStatus === 'fail') return { status: 'down', message: h.lastMessage ? `job reported failure: ${h.lastMessage}` : 'job reported failure' }
  if (age > grace) return { status: 'down', message: `no ping for ${formatDuration(age)} (grace ${formatDuration(grace)})` }
  return { status: 'up' }
}

export async function evaluateHeartbeats(deps: RecordDeps & { db: Db }, now = new Date()): Promise<number> {
  let n = 0
  for (const h of await listHeartbeats(deps.db)) {
    const result = heartbeatResult(h, now.getTime())
    if (!result) continue
    await recordResult({ ...deps, vantage: HEARTBEAT_VANTAGE }, h.checkId, result, now, { expected: [HEARTBEAT_VANTAGE] })
    n++
  }
  return n
}

export function startHeartbeatEvaluator(deps: RecordDeps & { db: Db }) {
  const timer = setInterval(() => {
    evaluateHeartbeats(deps).catch((err) => console.error('heartbeat evaluator failed:', err.message))
  }, HEARTBEAT_INTERVAL_MS)
  return { close: () => clearInterval(timer) }
}
