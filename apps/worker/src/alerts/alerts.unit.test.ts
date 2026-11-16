import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { alertsConfigFromEnv } from './config'
import { parseCommand, resolveTarget } from './bot'
import { formatDuration, parseDuration } from './duration'
import { digestText, escapeHtml, incidentGroup, incidentOpened, incidentRemoved, incidentResolved, toPlain } from './format'
import { TelegramClient, TelegramError } from './telegram'
import { pingOnce } from './watchdog'
import { heartbeatResult } from '../heartbeat'

describe('durations', () => {
  it('parses simple and compound values within 1 minute .. 7 days', () => {
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('1h30m')).toBe(5_400_000)
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('7d')).toBe(7 * 86_400_000)
  })
  it('rejects junk and out-of-range values', () => {
    for (const bad of ['', 'abc', '2', '-1h', '2x', '30s', '8d', '0m', '1h 30m', '2h;drop']) expect(parseDuration(bad), bad).toBeNull()
  })
  it('formats', () => {
    expect(formatDuration(30_000)).toBe('<1m')
    expect(formatDuration(12 * 60_000)).toBe('12m')
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
  })
})

describe('message formatting', () => {
  const base = { targetName: '<b>evil</b> & co', checkKind: 'http', cause: 'HTTP 500 <script>', openedAt: new Date('2026-10-29T10:00:00Z') }
  it('escapes target names and causes', () => {
    const t = incidentOpened(base)
    expect(t).not.toContain('<script>')
    expect(t).not.toContain('<b>evil</b>')
    expect(t).toContain('&lt;b&gt;evil&lt;/b&gt; &amp; co')
    expect(escapeHtml('a<b>&')).toBe('a&lt;b&gt;&amp;')
  })
  it('resolved message says recovered and how long it took', () => {
    const t = incidentResolved({ ...base, resolvedAt: new Date('2026-10-29T10:12:00Z') })
    expect(t).toContain('recovered after 12m')
  })
  it('plain text for email drops the markup and restores the escaped characters', () => {
    const p = toPlain(incidentOpened({ ...base, url: 'https://pulse.example' }))
    expect(p).not.toContain('&lt;')
    expect(p).not.toContain('<a href')
    expect(p.startsWith('🔴 <b>evil</b> & co is DOWN')).toBe(true) // the target's own name, not our markup
    expect(p).toContain('Open Pulse (https://pulse.example)')
  })
  it('digest lists expiries and says all clear when nothing is wrong', () => {
    const t = digestText({ date: '29 Oct 2026', openIncidents: [], degraded: [], expiries: [{ targetName: 'Site', checkKind: 'tls', daysLeft: 9 }] })
    expect(t).toContain('All systems operational.')
    expect(t).toContain('🔴 Site · tls · 9 days')
  })
})

describe('bot command parsing', () => {
  it('parses commands with args and @botname', () => {
    expect(parseCommand('/start ABC123')).toEqual({ cmd: 'start', args: ['ABC123'] })
    expect(parseCommand('/mute@PulseBot site 2h')).toEqual({ cmd: 'mute', args: ['site', '2h'] })
    expect(parseCommand('hello')).toBeNull()
  })
  it('resolves targets by exact match, unique substring, and reports ambiguity', () => {
    const list = [
      { id: 'client-portal', name: 'Client portal' },
      { id: 'rocobroker-site', name: 'rocobroker.com' },
      { id: 'roco-seo', name: 'roco-seo agents' },
    ]
    expect(resolveTarget(list, 'client-portal')).toEqual(list[0])
    expect(resolveTarget(list, 'portal')).toEqual(list[0])
    expect(Array.isArray(resolveTarget(list, 'roco'))).toBe(true)
    expect(resolveTarget(list, 'nothing')).toBeNull()
  })
})

describe('heartbeatResult', () => {
  const now = Date.parse('2026-10-29T12:00:00Z')
  const row = (o: Partial<Parameters<typeof heartbeatResult>[0]>) => ({
    checkId: 'x',
    graceS: 600,
    lastPingAt: new Date(now - 60_000),
    lastStatus: 'ok',
    lastMessage: null,
    createdAt: new Date(now - 86_400_000),
    ...o,
  })
  it('up inside grace, down after it', () => {
    expect(heartbeatResult(row({}), now)).toEqual({ status: 'up' })
    expect(heartbeatResult(row({ lastPingAt: new Date(now - 601_000) }), now)?.status).toBe('down')
  })
  it('a reported failure is down even when the ping is fresh', () => {
    expect(heartbeatResult(row({ lastStatus: 'fail', lastMessage: 'exit 2' }), now)).toMatchObject({ status: 'down', message: expect.stringContaining('exit 2') })
  })
  it('never pinged: silent during the first grace period, down afterwards', () => {
    expect(heartbeatResult(row({ lastPingAt: null, createdAt: new Date(now - 60_000) }), now)).toBeNull()
    expect(heartbeatResult(row({ lastPingAt: null, createdAt: new Date(now - 700_000) }), now)?.status).toBe('down')
  })
})

describe('TelegramClient', () => {
  let server: Server
  let base: string
  const calls: string[] = []
  let mode: 'ok' | 'flaky' | 'forbidden' | 'notmodified' = 'ok'
  let n = 0

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls.push(req.url!)
      n++
      res.setHeader('content-type', 'application/json')
      if (mode === 'forbidden') return void res.writeHead(403).end(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }))
      if (mode === 'flaky' && n % 3 !== 0) return void res.writeHead(502).end(JSON.stringify({ ok: false, description: 'Bad Gateway' }))
      if (mode === 'notmodified') return void res.writeHead(400).end(JSON.stringify({ ok: false, description: 'Bad Request: message is not modified' }))
      res.end(JSON.stringify({ ok: true, result: { message_id: 77 } }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => void server.close())

  const client = () => new TelegramClient('TOKEN', base, 3, 1)

  it('sends and returns the message id', async () => {
    mode = 'ok'
    expect(await client().sendMessage('1', 'hi')).toBe(77)
    expect(calls.at(-1)).toBe('/botTOKEN/sendMessage')
  })
  it('retries transient failures', async () => {
    mode = 'flaky'
    n = 0
    expect(await client().sendMessage('1', 'hi')).toBe(77)
    expect(n).toBe(3)
  })
  it('does not retry permanent errors', async () => {
    mode = 'forbidden'
    n = 0
    await expect(client().sendMessage('1', 'hi')).rejects.toMatchObject({ permanent: true })
    expect(n).toBe(1)
  })
  it('treats "message is not modified" on edit as success', async () => {
    mode = 'notmodified'
    await expect(client().editMessage('1', 5, 'same')).resolves.toBeUndefined()
  })
  it('gives up after the attempts and reports a transient error', async () => {
    mode = 'flaky'
    n = 1 // 2,3 -> fail, ok on 3rd... force always failing instead
    const failing = new TelegramClient('T', 'http://127.0.0.1:1', 2, 1)
    await expect(failing.sendMessage('1', 'x')).rejects.toBeInstanceOf(TelegramError)
  })
})

describe('watchdog', () => {
  let server: Server
  let url: string
  let hits = 0
  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++
      res.end('OK')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping`
  })
  afterAll(() => void server.close())

  it('pings when healthy and the scheduler is producing results', async () => {
    const now = Date.now()
    expect(await pingOnce({ url, healthy: async () => true, lastResultAt: () => now - 10_000 }, now)).toBe(true)
    expect(hits).toBe(1)
  })
  it('stays silent when the database is down or the scheduler has stalled', async () => {
    const now = Date.now()
    hits = 0
    expect(await pingOnce({ url, healthy: async () => { throw new Error('db') }, lastResultAt: () => now }, now)).toBe(false)
    expect(await pingOnce({ url, healthy: async () => true, lastResultAt: () => now - 6 * 60_000 }, now)).toBe(false)
    expect(hits).toBe(0)
  })
  it('a scheduler that is disabled by config (null) does not block pings', async () => {
    expect(await pingOnce({ url, healthy: async () => true, lastResultAt: () => null })).toBe(true)
  })
})

describe('alerts config', () => {
  it('is off unless ALERTS_ENABLED is exactly "true"', () => {
    expect(alertsConfigFromEnv({}).enabled).toBe(false)
    expect(alertsConfigFromEnv({ ALERTS_ENABLED: 'false' }).enabled).toBe(false)
    expect(alertsConfigFromEnv({ ALERTS_ENABLED: '1' }).enabled).toBe(false)
    expect(alertsConfigFromEnv({ ALERTS_ENABLED: 'true' }).enabled).toBe(true)
  })
  it('smtp is optional', () => {
    expect(alertsConfigFromEnv({}).smtp).toBeUndefined()
    expect(alertsConfigFromEnv({ SMTP_HOST: 'h', SMTP_FROM: 'a@b' }).smtp).toMatchObject({ host: 'h', port: 587, from: 'a@b' })
  })
})

describe('ALERTS_ENABLED=false', () => {
  it('starts nothing: no Telegram, no timers, no queues (deps are never touched)', async () => {
    const { startAlerts } = await import('./index')
    const boom = new Proxy({}, { get: () => { throw new Error('touched a dependency') } }) as never
    const a = await startAlerts({
      cfg: alertsConfigFromEnv({ ALERTS_ENABLED: 'false', TELEGRAM_BOT_TOKEN: 'x', WATCHDOG_URL: 'http://127.0.0.1:1/' }),
      db: boom, redis: boom, connection: boom, store: boom, targets: [],
      healthy: async () => true, lastResultAt: () => null, log: () => {},
    })
    expect(() => a.onEvent('c', { type: 'degraded_sustained' })).not.toThrow()
    await a.close()
  })
  it('refuses to start enabled without a bot token', async () => {
    const { startAlerts } = await import('./index')
    await expect(
      startAlerts({ cfg: alertsConfigFromEnv({ ALERTS_ENABLED: 'true' }), db: {} as never, redis: {} as never, connection: {} as never, store: {} as never, targets: [], healthy: async () => true, lastResultAt: () => null, log: () => {} }),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/)
  })
})

describe('group and removal messages', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 16, 12, m))
  const a = { targetName: 'A <x>', checkKind: 'http', cause: 'HTTP 500', openedAt: at(0) }
  const b = { targetName: 'B', checkKind: 'tls', cause: null, openedAt: at(1) }
  it('headline follows how many are still down, and values are escaped', () => {
    expect(incidentGroup([a, b])).toContain('2 targets are DOWN')
    expect(incidentGroup([{ ...a, resolvedAt: at(5) }, b])).toContain('1 of 2 targets still DOWN')
    expect(incidentGroup([{ ...a, resolvedAt: at(5) }, { ...b, resolvedAt: at(6) }])).toContain('2 targets recovered')
    expect(incidentGroup([a, b])).toContain('A &lt;x&gt;')
    expect(incidentGroup([a, b])).not.toMatch(/\b\d+\.\d+\.\d+\.\d+\b/) // never shows a host/IP
  })
  it('removal text names the target and says why the message changed', () => {
    const t = incidentRemoved({ ...a, resolvedAt: at(5) })
    expect(t).toContain('A &lt;x&gt;')
    expect(t).toContain('removed from monitoring')
  })
})
