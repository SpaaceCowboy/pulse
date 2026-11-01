import {
  aggregateVantages,
  initialState,
  reduce,
  type CheckResult,
  type CheckState,
  type StateEvent,
  type VantageObservation,
} from '@pulse/core'
import { closeIncident, hasOpenIncident, insertResult, openIncident, type Db } from '@pulse/db'
import type { StateStore } from './state-store'

export const LOCAL_VANTAGE = 'core'

export interface RecordDeps {
  db: Db
  store: StateStore
  vantage?: string
  log?: (msg: string) => void
  /** called for every state-machine event, after incidents were opened/closed */
  onEvent?: (checkId: string, e: StateEvent, state: CheckState) => void
}

export interface RoundContext {
  /** vantages that vote on this check (targets.yaml `vantage`, default just this one) */
  expected?: string[]
  /** a peer's latest result older than this is ignored (it may be down, or its network blocked) */
  staleAfterMs?: number
}

/**
 * Persist one check result: raw row -> state machine -> incident open/close -> latest state.
 * Events are applied before the new state is saved, and open/close are idempotent, so a crash
 * between the two steps only replays the same transition.
 *
 * Each call is one "round" of the state machine. With several vantages the round is clocked by this
 * vantage's result and the other vantages contribute their freshest result (written by /api/ingest),
 * so 3 failures still means 3 rounds, and a minority of vantages failing is "regional", never an incident.
 */
export async function recordResult(
  deps: RecordDeps,
  checkId: string,
  result: CheckResult,
  now: Date = new Date(),
  ctx: RoundContext = {},
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

  const votes: VantageObservation[] = [{ vantage, status: result.status, message: result.message }]
  const peers = (ctx.expected ?? []).filter((v) => v !== vantage)
  if (peers.length > 0) {
    await deps.store.setVantage(checkId, vantage, { status: result.status, ts: now.getTime(), message: result.message })
    const entries = await deps.store.getVantages(checkId)
    const maxAge = ctx.staleAfterMs ?? 180_000
    for (const p of peers) {
      const e = entries[p]
      if (e && now.getTime() - e.ts <= maxAge) votes.push({ vantage: p, status: e.status, message: e.message })
    }
  }
  const obs = aggregateVantages(votes, now.getTime())
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
    last: {
      // the aggregated verdict, so a regional split shows as degraded ("regional: down from hostvds")
      status: obs.status,
      ts: now.getTime(),
      latencyMs: result.latencyMs,
      message: obs.message ?? result.message,
      daysLeft: typeof result.meta?.daysLeft === 'number' ? result.meta.daysLeft : undefined,
    },
  })
  for (const e of events) deps.onEvent?.(checkId, e, state)
  return { state, events }
}

/** Redis lost its key: an open incident in Postgres means the check is still down, else start clean. */
async function rebuildState(db: Db, checkId: string, now: Date): Promise<CheckState> {
  return (await hasOpenIncident(db, checkId))
    ? { ...initialState(), phase: 'down', changedAt: now.getTime() }
    : initialState()
}
