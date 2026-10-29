import {
  aggregateVantages,
  initialState,
  reduce,
  type CheckResult,
  type CheckState,
  type StateEvent,
} from '@pulse/core'
import { closeIncident, hasOpenIncident, insertResult, openIncident, type Db } from '@pulse/db'
import type { StateStore } from './state-store'

export const LOCAL_VANTAGE = 'core'

export interface RecordDeps {
  db: Db
  store: StateStore
  vantage?: string
  log?: (msg: string) => void
}

/**
 * Persist one check result: raw row -> state machine -> incident open/close -> latest state.
 * Events are applied before the new state is saved, and open/close are idempotent, so a crash
 * between the two steps only replays the same transition.
 */
export async function recordResult(
  deps: RecordDeps,
  checkId: string,
  result: CheckResult,
  now: Date = new Date(),
): Promise<{ state: CheckState; events: StateEvent[] }> {
  const vantage = deps.vantage ?? LOCAL_VANTAGE
  await insertResult(deps.db, {
    checkId,
    vantage,
    ts: now,
    status: result.status,
    latencyMs: result.latencyMs,
    message: result.message,
  })

  const prev = (await deps.store.get(checkId))?.state ?? (await rebuildState(deps.db, checkId, now))
  const obs = aggregateVantages([{ vantage, status: result.status, message: result.message }], now.getTime())
  const { state, events } = reduce(prev, obs)

  for (const e of events) {
    if (e.type === 'open_incident') {
      await openIncident(deps.db, { checkId, openedAt: now, cause: e.cause, lastMessage: result.message })
      deps.log?.(`incident opened: ${checkId} (${e.cause ?? 'no message'})`)
    } else if (e.type === 'close_incident') {
      await closeIncident(deps.db, checkId, now)
      deps.log?.(`incident resolved: ${checkId}`)
    } else {
      deps.log?.(`${e.type}: ${checkId}`)
    }
  }

  await deps.store.set(checkId, {
    state,
    last: { status: result.status, ts: now.getTime(), latencyMs: result.latencyMs, message: result.message },
  })
  return { state, events }
}

/** Redis lost its key: an open incident in Postgres means the check is still down, else start clean. */
async function rebuildState(db: Db, checkId: string, now: Date): Promise<CheckState> {
  return (await hasOpenIncident(db, checkId))
    ? { ...initialState(), phase: 'down', changedAt: now.getTime() }
    : initialState()
}
