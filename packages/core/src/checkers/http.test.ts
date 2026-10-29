import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closedPort, startHttpFixture, type Fixture } from '../testing/fixture-server'
import { httpConfigSchema, type HttpConfig } from './config'
import { httpChecker } from './http'

let fx: Fixture
beforeAll(async () => {
  fx = await startHttpFixture()
})
afterAll(() => fx.close())

const cfg = (path: string, extra: Record<string, unknown> = {}): HttpConfig =>
  httpConfigSchema.parse({ url: fx.url(path), ...extra })
const run = (c: HttpConfig, ms = 5000) => httpChecker.run(c, AbortSignal.timeout(ms))

describe('httpChecker', () => {
  it('200 is up', async () => {
    const r = await run(cfg('/ok'))
    expect(r.status).toBe('up')
    expect(r.latencyMs).toBeDefined()
  })
  it('500 is down', async () => {
    expect((await run(cfg('/500'))).status).toBe('down')
  })
  it('404 when 200 expected is degraded', async () => {
    expect((await run(cfg('/404'))).status).toBe('degraded')
  })
  it('404 expected is up', async () => {
    expect((await run(cfg('/404', { expect_status: 404 }))).status).toBe('up')
  })
  it('expect_status array', async () => {
    expect((await run(cfg('/404', { expect_status: [200, 404] }))).status).toBe('up')
    expect((await run(cfg('/ok', { expect_status: [201, 204] }))).status).toBe('down')
  })
  it('slow beyond latency_degraded_ms is degraded', async () => {
    const r = await run(cfg('/slow?ms=300', { latency_degraded_ms: 100 }))
    expect(r.status).toBe('degraded')
  })
  it('slow beyond abort signal is down with timeout', async () => {
    const r = await run(cfg('/slow?ms=3000'), 200)
    expect(r.status).toBe('down')
    expect(r.message).toBe('timeout')
  })
  it('keyword present / missing', async () => {
    expect((await run(cfg('/ok', { keyword: 'login' }))).status).toBe('up')
    const r = await run(cfg('/ok', { keyword: 'nonexistent' }))
    expect(r.status).toBe('down')
    expect(r.message).toContain('keyword')
  })
  it('follows 3 redirects, fails on 4', async () => {
    expect((await run(cfg('/redirect?n=3'))).status).toBe('up')
    const r = await run(cfg('/redirect?n=4'))
    expect(r.status).toBe('down')
    expect(r.message).toContain('redirect')
  })
  it('closed port is down', async () => {
    const port = await closedPort()
    const r = await run(httpConfigSchema.parse({ url: `http://127.0.0.1:${port}/` }))
    expect(r.status).toBe('down')
    expect(r.message).toBeTruthy()
  })
})
