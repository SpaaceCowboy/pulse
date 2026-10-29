import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jsonConfigSchema } from './config'
import { jsonChecker } from './json'
import { startHttpFixture, type Fixture } from '../testing/fixture-server'

let fx: Fixture
let echo: Server
let echoPort: number
beforeAll(async () => {
  fx = await startHttpFixture()
  echo = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', token: req.headers['x-health-token'] ?? null }))
  })
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
  echoPort = (echo.address() as AddressInfo).port
})
afterAll(async () => {
  await fx.close()
  echo.closeAllConnections()
  await new Promise<void>((r) => echo.close(() => r()))
})

const cfg = (path: string, extra: Record<string, unknown> = {}) =>
  jsonConfigSchema.parse({ url: fx.url(path), ...extra })
const sig = () => AbortSignal.timeout(5000)

describe('jsonChecker', () => {
  it('up on healthy /health with version', async () => {
    const r = await jsonChecker.run(cfg('/health'), sig())
    expect(r.status).toBe('up')
    expect(r.meta?.version).toBe('1.0.0')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })
  it('degraded when a check is degraded', async () => {
    const r = await jsonChecker.run(cfg('/health-degraded'), sig())
    expect(r.status).toBe('degraded')
    expect(r.message).toContain('vendor')
  })
  it('errors[] go to meta without changing status', async () => {
    const r = await jsonChecker.run(cfg('/health-errors'), sig())
    expect(r.status).toBe('up')
    expect(r.meta?.errors).toEqual([{ title: 'Payment webhook failed', count: 3 }])
    expect(r.message).toContain('1 error')
  })
  it('down when status is down', async () => {
    const r = await jsonChecker.run(cfg('/health-down'), sig())
    expect(r.status).toBe('down')
    expect(r.message).toContain('$.status')
  })
  it('down on non-JSON and non-2xx', async () => {
    expect((await jsonChecker.run(cfg('/health-bad'), sig())).status).toBe('down')
    const r = await jsonChecker.run(cfg('/500'), sig())
    expect(r.status).toBe('down')
    expect(r.message).toContain('500')
  })
  it('custom assertions', async () => {
    const ok = await jsonChecker.run(
      cfg('/health', {
        assertions: [
          { path: '$.checks.db.status', equals: 'ok' },
          { path: '$.nope', exists: false },
          { path: '$.version', exists: true },
        ],
      }),
      sig(),
    )
    expect(ok.status).toBe('up')
    const bad = await jsonChecker.run(
      cfg('/health', { assertions: [{ path: '$.checks.db.status', equals: 'bad' }, { path: '$.version', exists: false }] }),
      sig(),
    )
    expect(bad.status).toBe('down')
    expect(bad.message).toContain('$.checks.db.status')
    expect(bad.message).toContain('$.version')
  })
  it('sends token header from env, never in result', async () => {
    process.env.PULSE_TEST_TOKEN = 'sekret123'
    const c = jsonConfigSchema.parse({
      url: `http://127.0.0.1:${echoPort}/`,
      token_header: 'x-health-token',
      token_env: 'PULSE_TEST_TOKEN',
      assertions: [{ path: '$.token', equals: 'sekret123' }],
    })
    const r = await jsonChecker.run(c, sig())
    expect(r.status).toBe('up')
    expect(JSON.stringify(r)).not.toContain('sekret123')
    delete process.env.PULSE_TEST_TOKEN
    expect((await jsonChecker.run(c, sig())).status).toBe('down')
  })
  it('times out and does not throw', async () => {
    const r = await jsonChecker.run(cfg('/slow?ms=2000'), AbortSignal.timeout(100))
    expect(r.status).toBe('down')
    expect(r.message).toBe('timeout')
  })
  it('down on connection refused', async () => {
    const r = await jsonChecker.run(jsonConfigSchema.parse({ url: 'http://127.0.0.1:1/' }), sig())
    expect(r.status).toBe('down')
  })
})