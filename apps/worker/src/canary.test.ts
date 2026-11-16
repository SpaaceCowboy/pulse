import { describe, expect, it } from 'vitest'
import { createCoreOnline } from './canary'

const eps = [
  { host: 'a', port: 1 },
  { host: 'b', port: 1 },
]

describe('createCoreOnline', () => {
  it('is online when any endpoint answers, offline only when all fail', async () => {
    expect(await createCoreOnline({ endpoints: eps, probe: async (e) => e.host === 'b' })()).toBe(true)
    expect(await createCoreOnline({ endpoints: eps, probe: async () => false })()).toBe(false)
  })

  it('probes once per 15 s window, then again', async () => {
    let calls = 0
    let t = 1_000
    const online = createCoreOnline({
      endpoints: eps,
      now: () => t,
      probe: async () => {
        calls++
        return true
      },
    })
    await Promise.all([online(), online(), online()])
    expect(calls).toBe(2) // two endpoints, one round
    t += 14_999
    await online()
    expect(calls).toBe(2)
    t += 1
    await online()
    expect(calls).toBe(4)
  })
})
