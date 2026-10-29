import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { closedPort, startTcpFixture, type Fixture } from '../testing/fixture-server'
import { createTcpChecker, tcpChecker } from './tcp'

let fx: Fixture | undefined
afterEach(async () => {
  await fx?.close()
  fx = undefined
})

function fakeSocket(connectAfterMs?: number) {
  const ee = new EventEmitter() as EventEmitter & { destroyed: boolean; destroy: () => void }
  ee.destroyed = false
  ee.destroy = () => {
    ee.destroyed = true
  }
  if (connectAfterMs !== undefined) setTimeout(() => ee.emit('connect'), connectAfterMs)
  return ee
}

describe('tcp checker', () => {
  it('is up on an open port', async () => {
    fx = await startTcpFixture()
    const r = await tcpChecker.run({ host: '127.0.0.1', port: fx.port, slow_ms: 1000 }, AbortSignal.timeout(2000))
    expect(r.status).toBe('up')
    expect(r.latencyMs).toBeTypeOf('number')
    expect(r.meta).toEqual({ host: '127.0.0.1', port: fx.port })
  })

  it('is down with ECONNREFUSED on a closed port', async () => {
    const port = await closedPort()
    const r = await tcpChecker.run({ host: '127.0.0.1', port, slow_ms: 1000 }, AbortSignal.timeout(2000))
    expect(r.status).toBe('down')
    expect(r.message).toContain('ECONNREFUSED')
  })

  it('is degraded when connect exceeds slow_ms', async () => {
    const sock = fakeSocket(60)
    const c = createTcpChecker(() => sock as unknown as Socket)
    const r = await c.run({ host: 'h', port: 1, slow_ms: 10 }, AbortSignal.timeout(2000))
    expect(r.status).toBe('degraded')
    expect(sock.destroyed).toBe(true)
  })

  it('is down "timeout" on abort and destroys the socket', async () => {
    const sock = fakeSocket()
    const c = createTcpChecker(() => sock as unknown as Socket)
    const r = await c.run({ host: 'h', port: 1, slow_ms: 1000 }, AbortSignal.timeout(100))
    expect(r.status).toBe('down')
    expect(r.message).toBe('timeout')
    expect(sock.destroyed).toBe(true)
  })

  it('is down immediately if already aborted', async () => {
    const r = await tcpChecker.run({ host: '127.0.0.1', port: 9, slow_ms: 1000 }, AbortSignal.abort())
    expect(r).toMatchObject({ status: 'down', message: 'timeout' })
  })
})
