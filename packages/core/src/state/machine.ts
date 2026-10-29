// Per-check state machine from docs/PLAN.md "Alerting & incident logic".
// up -> suspect -> down -> recovering -> up; `degraded` is tracked on the side.
// Pure: no I/O, no clocks, never mutates its input.
import type { CheckResult } from '../types'

export type Phase = 'up' | 'suspect' | 'down' | 'recovering'

export const FAILS_TO_OPEN = 3
export const PASSES_TO_CLOSE = 2
export const DEGRADED_ALERT_AFTER_MS = 15 * 60_000

export interface CheckState {
  phase: Phase
  /** consecutive failures while up/suspect */
  fails: number
  /** consecutive passes while recovering */
  passes: number
  /** epoch ms of the first result of the current uninterrupted degraded streak */
  degradedSince: number | null
  /** true once the degraded streak outlasted DEGRADED_ALERT_AFTER_MS */
  degradedSustained: boolean
  /** epoch ms of the last phase change (initial state: 0) */
  changedAt: number
}

export interface Observation {
  status: CheckResult['status']
  /** epoch ms */
  ts: number
  message?: string
}

export type StateEvent =
  | { type: 'open_incident'; cause?: string }
  | { type: 'close_incident' }
  | { type: 'degraded_sustained' }
  | { type: 'degraded_cleared' }

export const initialState = (): CheckState => ({
  phase: 'up',
  fails: 0,
  passes: 0,
  degradedSince: null,
  degradedSustained: false,
  changedAt: 0,
})

/** `degraded` is reachable, so it counts as a pass for the incident path. */
export function reduce(
  prev: CheckState,
  obs: Observation,
): { state: CheckState; events: StateEvent[] } {
  const events: StateEvent[] = []
  const s: CheckState = { ...prev }
  const move = (phase: Phase) => {
    s.phase = phase
    s.changedAt = obs.ts
  }

  if (obs.status === 'down') {
    s.passes = 0
    switch (s.phase) {
      case 'up':
        s.fails = 1
        move('suspect')
        break
      case 'suspect':
        s.fails += 1
        if (s.fails >= FAILS_TO_OPEN) {
          move('down')
          events.push({ type: 'open_incident', cause: obs.message })
        }
        break
      case 'recovering':
        move('down')
        break
      case 'down':
        break
    }
  } else {
    switch (s.phase) {
      case 'suspect':
        s.fails = 0
        move('up')
        break
      case 'down':
        s.passes = 1
        move('recovering')
        break
      case 'recovering':
        s.passes += 1
        if (s.passes >= PASSES_TO_CLOSE) {
          s.passes = 0
          s.fails = 0
          move('up')
          events.push({ type: 'close_incident' })
        }
        break
      case 'up':
        break
    }
  }

  // degraded is its own track: an uninterrupted streak of degraded results
  if (obs.status === 'degraded') {
    s.degradedSince = prev.degradedSince ?? obs.ts
    if (!s.degradedSustained && obs.ts - s.degradedSince > DEGRADED_ALERT_AFTER_MS) {
      s.degradedSustained = true
      events.push({ type: 'degraded_sustained' })
    }
  } else {
    if (prev.degradedSustained) events.push({ type: 'degraded_cleared' })
    s.degradedSince = null
    s.degradedSustained = false
  }

  return { state: s, events }
}

export interface VantageObservation {
  vantage: string
  status: CheckResult['status']
  message?: string
}

/**
 * Collapse one round of per-vantage results into one observation.
 * Majority down => down. A minority down is a regional problem => degraded, no page.
 */
export function aggregateVantages(
  results: VantageObservation[],
  ts: number,
): Observation {
  if (results.length === 0) throw new Error('aggregateVantages: no results')
  const down = results.filter((r) => r.status === 'down')
  if (down.length * 2 > results.length) {
    return { status: 'down', ts, message: down[0]!.message }
  }
  if (down.length > 0) {
    const names = down.map((r) => r.vantage).join(', ')
    return { status: 'degraded', ts, message: `regional: down from ${names}` }
  }
  const degraded = results.find((r) => r.status === 'degraded')
  if (degraded) return { status: 'degraded', ts, message: degraded.message }
  return { status: 'up', ts }
}
