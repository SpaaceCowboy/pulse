import { describe, expect, it } from 'vitest'
import {
  aggregateVantages,
  DEGRADED_ALERT_AFTER_MS,
  initialState,
  reduce,
  type CheckState,
  type Observation,
  type StateEvent,
} from './machine'

const MIN = 60_000

/** Feed a status sequence one minute apart; returns final state and all events. */
function run(statuses: Observation['status'][], from: CheckState = initialState(), start = MIN) {
  let state = from
  const events: StateEvent[] = []
  const phases: string[] = []
  statuses.forEach((status, i) => {
    const r = reduce(state, { status, ts: start + i * MIN, message: status === 'down' ? 'boom' : undefined })
    state = r.state
    events.push(...r.events)
    phases.push(state.phase)
  })
  return { state, events, phases }
}

describe('reduce: incident path', () => {
  it('fail-fail-fail-pass-pass opens exactly one incident and closes it', () => {
    const { events, phases, state } = run(['down', 'down', 'down', 'up', 'up'])
    expect(phases).toEqual(['suspect', 'suspect', 'down', 'recovering', 'up'])
    expect(events).toEqual([{ type: 'open_incident', cause: 'boom' }, { type: 'close_incident' }])
    expect(state.phase).toBe('up')
  })

  it('two failures then a pass resets the streak without an incident', () => {
    const { events, phases } = run(['down', 'down', 'up', 'down', 'down', 'up'])
    expect(phases).toEqual(['suspect', 'suspect', 'up', 'suspect', 'suspect', 'up'])
    expect(events).toEqual([])
  })

  it('a failure while recovering goes back to down without a second incident', () => {
    const { events, phases } = run(['down', 'down', 'down', 'up', 'down', 'up', 'up'])
    expect(phases).toEqual(['suspect', 'suspect', 'down', 'recovering', 'down', 'recovering', 'up'])
    expect(events.map((e) => e.type)).toEqual(['open_incident', 'close_incident'])
  })

  it('a long outage emits open once', () => {
    const { events } = run(Array(20).fill('down'))
    expect(events.filter((e) => e.type === 'open_incident')).toHaveLength(1)
  })

  it('needs two consecutive passes: one pass is only recovering', () => {
    const { state, events } = run(['down', 'down', 'down', 'up'])
    expect(state.phase).toBe('recovering')
    expect(events.map((e) => e.type)).toEqual(['open_incident'])
  })

  it('records when the phase last changed', () => {
    const { state } = run(['down', 'down', 'down'], initialState(), 10 * MIN)
    expect(state.changedAt).toBe(12 * MIN)
  })

  it('a second outage after recovery opens a second incident', () => {
    const { events } = run(['down', 'down', 'down', 'up', 'up', 'down', 'down', 'down'])
    expect(events.map((e) => e.type)).toEqual(['open_incident', 'close_incident', 'open_incident'])
  })
})

describe('reduce: degraded', () => {
  it('degraded never fails the incident path', () => {
    const { phases, events } = run(['degraded', 'degraded', 'degraded', 'degraded'])
    expect(phases).toEqual(['up', 'up', 'up', 'up'])
    expect(events).toEqual([])
  })

  it('degraded counts as a pass: it clears suspect and closes recovery', () => {
    expect(run(['down', 'degraded']).phases).toEqual(['suspect', 'up'])
    const { events } = run(['down', 'down', 'down', 'degraded', 'degraded'])
    expect(events.map((e) => e.type)).toEqual(['open_incident', 'close_incident'])
  })

  it('flags degradedSustained once, only after more than 15 minutes', () => {
    const n = DEGRADED_ALERT_AFTER_MS / MIN // results 0..n are exactly 15 min apart at the end
    const early = run(Array(n + 1).fill('degraded'))
    expect(early.state.degradedSustained).toBe(false)
    expect(early.events).toEqual([])

    const late = run(Array(n + 5).fill('degraded'))
    expect(late.state.degradedSustained).toBe(true)
    expect(late.events).toEqual([{ type: 'degraded_sustained' }])
  })

  it('clears the flag on the next non-degraded result', () => {
    const { state, events } = run([...Array(20).fill('degraded'), 'up'])
    expect(state.degradedSustained).toBe(false)
    expect(state.degradedSince).toBeNull()
    expect(events.map((e) => e.type)).toEqual(['degraded_sustained', 'degraded_cleared'])
  })

  it('an interruption restarts the degraded streak', () => {
    const { state, events } = run([...Array(10).fill('degraded'), 'up', ...Array(10).fill('degraded')])
    expect(state.degradedSustained).toBe(false)
    expect(events).toEqual([])
  })

  it('down is not degraded: it ends the degraded streak', () => {
    const { state } = run(['degraded', 'degraded', 'down'])
    expect(state.degradedSince).toBeNull()
  })
})

describe('reduce: purity', () => {
  it('does not mutate its input', () => {
    const prev = initialState()
    const frozen = Object.freeze({ ...prev })
    reduce(frozen, { status: 'down', ts: 1 })
    expect(prev).toEqual(initialState())
  })

  it('is deterministic', () => {
    const obs: Observation = { status: 'down', ts: 5 }
    expect(reduce(initialState(), obs)).toEqual(reduce(initialState(), obs))
  })
})

describe('aggregateVantages', () => {
  it('majority down is down', () => {
    const o = aggregateVantages(
      [
        { vantage: 'a', status: 'down', message: 'x' },
        { vantage: 'b', status: 'down' },
        { vantage: 'c', status: 'up' },
      ],
      7,
    )
    expect(o).toEqual({ status: 'down', ts: 7, message: 'x' })
  })

  it('one of two down is regional degraded, not down', () => {
    const o = aggregateVantages(
      [
        { vantage: 'core', status: 'up' },
        { vantage: 'probe', status: 'down' },
      ],
      1,
    )
    expect(o.status).toBe('degraded')
    expect(o.message).toMatch(/^regional: down from probe/)
  })

  it('single vantage passes through', () => {
    expect(aggregateVantages([{ vantage: 'core', status: 'down', message: 'm' }], 1).status).toBe('down')
    expect(aggregateVantages([{ vantage: 'core', status: 'up' }], 1).status).toBe('up')
    expect(aggregateVantages([{ vantage: 'core', status: 'degraded', message: 'slow' }], 1)).toEqual({
      status: 'degraded',
      ts: 1,
      message: 'slow',
    })
  })

  it('rejects an empty round', () => {
    expect(() => aggregateVantages([], 1)).toThrow()
  })
})
