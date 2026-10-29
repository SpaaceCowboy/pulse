import { describe, expect, it } from 'vitest'
import type { Target } from '@pulse/core'
import { DEFAULT_INTERVAL_S } from '@pulse/core'
import { jitteredIntervalMs } from './scheduler'
import { listChecks } from './run-check'

describe('jitteredIntervalMs', () => {
  it('rand=0 gives 0.9x, rand=1 gives 1.1x, rand=0.5 gives 1x', () => {
    expect(jitteredIntervalMs(60, () => 0)).toBe(54_000)
    expect(jitteredIntervalMs(60, () => 1)).toBe(66_000)
    expect(jitteredIntervalMs(60, () => 0.5)).toBe(60_000)
  })
  it('stays within +/-10% for random values', () => {
    for (let i = 0; i < 200; i++) {
      const ms = jitteredIntervalMs(300)
      expect(ms).toBeGreaterThanOrEqual(270_000)
      expect(ms).toBeLessThanOrEqual(330_000)
    }
  })
})

const target = (checks: unknown[]): Target => ({ id: 't1', name: 'T', checks }) as unknown as Target

describe('listChecks', () => {
  const refs = listChecks([
    target([
      { kind: 'http', config: { url: 'http://x' } },
      { kind: 'heartbeat', config: {} },
      { kind: 'agent', config: {} },
      { kind: 'queue', config: {} },
      { kind: 'tcp', interval_s: 30, timeout_ms: 60_000, config: { host: 'h', port: 1 } },
      { kind: 'dns', timeout_ms: 2000, config: {} },
    ]),
  ])
  it('skips passive kinds and keeps original index in the id', () => {
    expect(refs.map((r) => r.id)).toEqual(['t1:0:http', 't1:4:tcp', 't1:5:dns'])
  })
  it('applies DEFAULT_INTERVAL_S unless interval_s is set', () => {
    expect(refs[0]!.intervalS).toBe(DEFAULT_INTERVAL_S.http)
    expect(refs[1]!.intervalS).toBe(30)
  })
  it('defaults timeout to 10s and caps at 10000', () => {
    expect(refs[0]!.timeoutMs).toBe(10_000)
    expect(refs[1]!.timeoutMs).toBe(10_000)
    expect(refs[2]!.timeoutMs).toBe(2000)
  })
})
