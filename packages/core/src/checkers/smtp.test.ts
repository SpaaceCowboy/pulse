import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { closedPort } from '../testing/fixture-server'
import type { SmtpConfig } from './config'
import { smtpChecker } from './smtp'

const servers: Server[] = []
const sockets = new Set<Socket>()
async function fake(onConn: (s: Socket) => void): Promise<number> {
  const srv = createServer((s) => {
    sockets.add(s)
    s.on('error', () => {})
    onConn(s)
  })
  servers.push(srv)
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)))
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) => {
          s.close(() => r(null))
          for (const k of sockets) k.destroy()
        }),
    ),
  )
})

function smtpServer(ehloLines: string[], banner = '220 fake ESMTP ready\r\n') {
  return fake((s) => {
    s.write(banner)
    s.on('data', (d) => {
      const t = d.toString()
      if (t.startsWith('EHLO')) s.write(ehloLines.join('\r\n') + '\r\n')
      if (t.startsWith('QUIT')) s.end('221 bye\r\n')
    })
  })
}

const cfg = (port: number, o: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1',
  port,
  secure: false,
  require_starttls: true,
  ...o,
})
const sig = (ms = 3000) => AbortSignal.timeout(ms)

describe('smtpChecker', () => {
  it('up with STARTTLS and multi-line EHLO parsed', async () => {
    const port = await smtpServer(['250-mail.example', '250-SIZE 1000', '250-STARTTLS', '250 8BITMIME'])
    const r = await smtpChecker.run(cfg(port), sig())
    expect(r.status).toBe('up')
    expect(r.meta).toMatchObject({ starttls: true, extensions: ['SIZE 1000', 'STARTTLS', '8BITMIME'] })
    expect((r.meta as { banner: string }).banner).toContain('220 fake')
  })

  it('degraded without STARTTLS when required', async () => {
    const port = await smtpServer(['250-mail.example', '250 SIZE 1000'])
    const r = await smtpChecker.run(cfg(port), sig())
    expect(r.status).toBe('degraded')
    expect(r.message).toBe('no STARTTLS')
    expect(r.meta).toMatchObject({ starttls: false })
  })

  it('up without STARTTLS when not required', async () => {
    const port = await smtpServer(['250 mail.example'])
    const r = await smtpChecker.run(cfg(port, { require_starttls: false }), sig())
    expect(r.status).toBe('up')
  })

  it('down on timeout when no banner', async () => {
    const port = await fake(() => {})
    const r = await smtpChecker.run(cfg(port), sig(200))
    expect(r).toMatchObject({ status: 'down', message: 'timeout' })
  })

  it('down on 554 banner', async () => {
    const port = await smtpServer([], '554 go away\r\n')
    const r = await smtpChecker.run(cfg(port), sig())
    expect(r.status).toBe('down')
    expect(r.message).toContain('554')
  })

  it('down when EHLO rejected', async () => {
    const port = await smtpServer(['502 not implemented'])
    const r = await smtpChecker.run(cfg(port), sig())
    expect(r.status).toBe('down')
  })

  it('down on refused port', async () => {
    const port = await closedPort()
    const r = await smtpChecker.run(cfg(port), sig())
    expect(r.status).toBe('down')
    expect(r.message).toMatch(/ECONNREFUSED/)
  })

  it('down when response exceeds 8KB', async () => {
    const port = await fake((s) => {
      s.write('220-' + 'x'.repeat(9000))
    })
    const r = await smtpChecker.run(cfg(port), sig())
    expect(r.status).toBe('down')
  })
})
