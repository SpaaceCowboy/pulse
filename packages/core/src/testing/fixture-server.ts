import { createServer as createHttp, type Server } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { createServer as createTcp, type Server as TcpServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import selfsigned from 'selfsigned'

/** Local fixture HTTP(S)/TCP servers for checker tests. Never touches the network. */

export interface Fixture {
  port: number
  url: (path?: string) => string
  close: () => Promise<void>
}

function listen(server: Server | TcpServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

function closer(server: Server | TcpServer) {
  return () =>
    new Promise<void>((resolve) => {
      if ('closeAllConnections' in server) server.closeAllConnections()
      server.close(() => resolve())
    })
}

/**
 * HTTP fixture routes:
 *  /ok (200 "hello pulse")     /500        /404        /slow?ms=N (default 3000)
 *  /redirect?n=N -> N hops to /ok     /health (JSON ok)    /health-degraded
 *  /health-errors (ok + errors[])     /health-down (status "down")    /health-bad (not JSON)
 */
export async function startHttpFixture(): Promise<Fixture> {
  const server = createHttp((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    switch (u.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/html' })
        return void res.end('<html><body>hello pulse login</body></html>')
      case '/500':
        res.writeHead(500)
        return void res.end('boom')
      case '/404':
        res.writeHead(404)
        return void res.end('nope')
      case '/slow':
        return void setTimeout(() => res.end('slow'), Number(u.searchParams.get('ms') ?? 3000))
      case '/redirect': {
        const n = Number(u.searchParams.get('n') ?? 1)
        res.writeHead(302, { location: n > 1 ? `/redirect?n=${n - 1}` : '/ok' })
        return void res.end()
      }
      case '/health':
        return json(200, { status: 'ok', version: '1.0.0', uptimeS: 10, checks: { db: { status: 'ok' } }, errors: [] })
      case '/health-degraded':
        return json(200, { status: 'ok', checks: { db: { status: 'ok' }, vendor: { status: 'degraded' } }, errors: [] })
      case '/health-errors':
        return json(200, { status: 'ok', checks: {}, errors: [{ title: 'Payment webhook failed', count: 3 }] })
      case '/health-down':
        return json(200, { status: 'down', checks: { db: { status: 'down' } }, errors: [] })
      case '/health-bad':
        res.writeHead(200, { 'content-type': 'text/plain' })
        return void res.end('not json')
      default:
        res.writeHead(404)
        res.end()
    }
  })
  const port = await listen(server)
  return { port, url: (p = '/') => `http://127.0.0.1:${port}${p}`, close: closer(server) }
}

export type CertKind = 'valid' | 'expired' | 'wrong-host' | 'expiring-soon'

/** Self-signed cert. `days` = validity from now (negative-start for expired). */
export async function makeCert(kind: CertKind) {
  const now = new Date()
  const day = 86_400_000
  const altName = kind === 'wrong-host' ? 'other.example' : 'localhost'
  const [notBeforeDate, notAfterDate] =
    kind === 'expired'
      ? [new Date(now.getTime() - 30 * day), new Date(now.getTime() - 1 * day)]
      : kind === 'expiring-soon'
        ? [new Date(now.getTime() - 30 * day), new Date(now.getTime() + 5 * day)]
        : [new Date(now.getTime() - 1 * day), new Date(now.getTime() + 365 * day)]
  const pems = await selfsigned.generate([{ name: 'commonName', value: altName }], {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: altName }, { type: 7, ip: '127.0.0.1' }] }],
  })
  return { cert: pems.cert, key: pems.private }
}

/** HTTPS fixture on 127.0.0.1 serving a self-signed cert of the given kind. */
export async function startTlsFixture(kind: CertKind = 'valid'): Promise<Fixture & { cert: string }> {
  const { cert, key } = await makeCert(kind)
  const server = createHttps({ cert, key }, (_req, res) => {
    res.writeHead(200)
    res.end('tls ok')
  })
  const port = await listen(server)
  return { port, cert, url: (p = '/') => `https://localhost:${port}${p}`, close: closer(server) }
}

/** Raw TCP server; `onConnection` lets tests send banners. `delayMs` delays accepting data handling. */
export async function startTcpFixture(onConnection?: Parameters<typeof createTcp>[1]): Promise<Fixture> {
  const sockets = new Set<Socket>()
  const server = createTcp((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    onConnection?.(s)
  })
  const port = await listen(server)
  const close = closer(server)
  return {
    port,
    url: () => `tcp://127.0.0.1:${port}`,
    close: () => {
      for (const s of sockets) s.destroy()
      return close()
    },
  }
}

/** A port that is guaranteed closed (bind then release). */
export async function closedPort(): Promise<number> {
  const s = createTcp()
  const port = await listen(s)
  await closer(s)()
  return port
}
