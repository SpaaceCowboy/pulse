import { afterEach, describe, expect, it } from 'vitest'
import { closedPort, startTcpFixture, startTlsFixture, type Fixture } from '../testing/fixture-server'
import { tlsChecker } from './tls'

const open: Fixture[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()))
})
const sig = () => AbortSignal.timeout(5000)
const cfg = (port: number, extra = {}) => ({ host: '127.0.0.1', port, servername: 'localhost', warn_days: 14, ...extra })

describe('tlsChecker', () => {
  it('valid cert is up', async () => {
    const f = await startTlsFixture('valid')
    open.push(f)
    const r = await tlsChecker.run(cfg(f.port), sig())
    expect(r.status).toBe('up')
    expect(r.meta?.daysLeft).toBeGreaterThanOrEqual(363)
    expect(r.meta?.daysLeft).toBeLessThanOrEqual(365)
    expect(r.meta?.authorized).toBe(false)
    expect(typeof r.meta?.validTo).toBe('string')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('expired cert is down', async () => {
    const f = await startTlsFixture('expired')
    open.push(f)
    const r = await tlsChecker.run(cfg(f.port), sig())
    expect(r.status).toBe('down')
    expect(r.meta?.daysLeft as number).toBeLessThan(0)
  })

  it('wrong-host cert is down', async () => {
    const f = await startTlsFixture('wrong-host')
    open.push(f)
    const r = await tlsChecker.run(cfg(f.port), sig())
    expect(r.status).toBe('down')
    expect(r.message).toBe('hostname mismatch')
  })

  it('expiring-soon is degraded', async () => {
    const f = await startTlsFixture('expiring-soon')
    open.push(f)
    const r = await tlsChecker.run(cfg(f.port), sig())
    expect(r.status).toBe('degraded')
    expect(r.meta?.daysLeft).toBeLessThanOrEqual(5)
  })

  it('closed port is down', async () => {
    const r = await tlsChecker.run(cfg(await closedPort()), sig())
    expect(r.status).toBe('down')
    expect(r.message).toMatch(/ECONNREFUSED/)
  })

  it('abort against silent server is down timeout', async () => {
    const f = await startTcpFixture((s) => {
      s.on("error", () => {})
      s.resume() // never answers, but drain so close() can finish
    })
    open.push(f)
    const r = await tlsChecker.run(cfg(f.port), AbortSignal.timeout(300))
    expect(r).toMatchObject({ status: 'down', message: 'timeout' })
  })
})
