import { describe, expect, it } from 'vitest'
import { startHttpFixture, startTlsFixture } from './fixture-server'

describe('fixtures', () => {
  it('http fixture serves /ok', async () => {
    const f = await startHttpFixture()
    expect((await fetch(f.url('/ok'))).status).toBe(200)
    await f.close()
  })
  it('tls fixtures start for every cert kind', async () => {
    for (const k of ['valid', 'expired', 'wrong-host', 'expiring-soon'] as const) {
      const f = await startTlsFixture(k)
      expect(f.cert).toContain('BEGIN CERTIFICATE')
      await f.close()
    }
  })
})
