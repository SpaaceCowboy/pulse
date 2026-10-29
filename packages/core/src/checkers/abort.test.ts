import { describe, expect, it, vi } from 'vitest'

// Regression: undici can sit in DNS lookup / connect for ~10s without honoring the abort signal.
// Simulate a request() that never settles and ignores the signal; the checkers must still return
// promptly once their own signal aborts. No network involved.
vi.mock('undici', () => ({ request: () => new Promise(() => {}) }))

const { httpChecker } = await import('./http')
const { jsonChecker } = await import('./json')
const { createDomainChecker } = await import('./domain')
const { httpConfigSchema, jsonConfigSchema } = await import('./config')

const MARGIN_MS = 500

async function timed<T>(p: Promise<T>) {
  const s = performance.now()
  const r = await p
  return { r, ms: performance.now() - s }
}

describe('checkers honor abort even when the transport does not', () => {
  it('http returns timeout promptly', async () => {
    const cfg = httpConfigSchema.parse({ url: 'http://nowhere.example/' })
    const { r, ms } = await timed(httpChecker.run(cfg, AbortSignal.timeout(150)))
    expect(r).toMatchObject({ status: 'down', message: 'timeout' })
    expect(ms).toBeLessThan(150 + MARGIN_MS)
  })
  it('json returns timeout promptly', async () => {
    const cfg = jsonConfigSchema.parse({ url: 'http://nowhere.example/health' })
    const { r, ms } = await timed(jsonChecker.run(cfg, AbortSignal.timeout(150)))
    expect(r).toMatchObject({ status: 'down', message: 'timeout' })
    expect(ms).toBeLessThan(150 + MARGIN_MS)
  })
  it('domain default RDAP fetch returns degraded (not down) promptly', async () => {
    const whois = vi.fn(async () => '')
    const c = createDomainChecker({ whois })
    const { r, ms } = await timed(c.run({ domain: 'nowhere.example', warn_days: 30 }, AbortSignal.timeout(150)))
    expect(r).toMatchObject({ status: 'degraded', message: 'expiry unknown: timeout' })
    expect(ms).toBeLessThan(150 + MARGIN_MS)
    expect(whois).not.toHaveBeenCalled()
  })
})
