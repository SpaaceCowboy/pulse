import { connect } from 'node:net'
import { request } from 'undici'
import type { Checker, CheckResult } from '../types'
import type { DomainConfig } from './config'
import { USER_AGENT, errMessage, isAbort, nowMs, raceAbort } from './util'

const unknownExpiry = (startedAt: number): CheckResult => ({
  status: 'degraded',
  latencyMs: Math.round(nowMs() - startedAt),
  message: 'expiry unknown: timeout',
})

const DAY_MS = 86_400_000
const MAX_WHOIS_BYTES = 256 * 1024

export interface DomainDeps {
  fetchJson?: (url: string, signal: AbortSignal) => Promise<unknown>
  whois?: (server: string, query: string, signal: AbortSignal) => Promise<string>
  now?: () => number
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function parseDate(raw: string): Date | null {
  const s = raw.trim()
  let m = /^(\d{4})[-./](\d{2})[-./](\d{2})(?:[T\s]+(\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?)?/.exec(s)
  if (m) {
    const [, y, mo, d, time, tz] = m
    const iso = `${y}-${mo}-${d}T${time ?? '00:00:00'}${time ? (tz ?? 'Z') : 'Z'}`
    const dt = new Date(iso)
    return Number.isNaN(dt.getTime()) ? null : dt
  }
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})/.exec(s)
  if (m) {
    const dt = new Date(`${m[1]} ${m[2]} ${m[3]} 00:00:00 UTC`)
    return Number.isNaN(dt.getTime()) ? null : dt
  }
  return null
}

/** Extract the expiration event date from an RDAP domain response. */
export function parseRdapExpiry(json: unknown): Date | null {
  if (!json || typeof json !== 'object') return null
  const events = (json as { events?: unknown }).events
  if (!Array.isArray(events)) return null
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const { eventAction, eventDate } = ev as { eventAction?: unknown; eventDate?: unknown }
    if (typeof eventAction === 'string' && eventAction.toLowerCase() === 'expiration' && typeof eventDate === 'string') {
      const d = parseDate(eventDate)
      if (d) return d
    }
  }
  return null
}

const WHOIS_KEY =
  /^\s*(?:expire-date|expiry[ _-]?date|expiration[ _-]?date|registry expiry date|registrar registration expiration date|paid-till|expires(?: on)?|renewal date)\s*[:.]+\s*(.+?)\s*$/i

/** Extract the expiry date from free-form WHOIS text. */
export function parseWhoisExpiry(text: string): Date | null {
  for (const line of text.split(/\r?\n/)) {
    const m = WHOIS_KEY.exec(line)
    if (!m) continue
    const d = parseDate(m[1]!)
    if (d) return d
  }
  return null
}

async function defaultFetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await raceAbort(
      (async () => {
        const res = await request(url, {
          method: 'GET',
          headers: { 'user-agent': USER_AGENT, accept: 'application/rdap+json, application/json' },
          maxRedirections: 5,
          signal: ac.signal,
        } as Parameters<typeof request>[1])
        if (res.statusCode < 200 || res.statusCode >= 300) {
          await res.body.dump().catch(() => undefined)
          throw new Error(`RDAP HTTP ${res.statusCode}`)
        }
        return res.body.json()
      })(),
      signal,
    )
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function defaultWhois(server: string, query: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const socket = connect({ host: server, port: 43 })
    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      socket.destroy()
      if (err) reject(err)
      else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onAbort = () => finish(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    socket.on('connect', () => socket.write(`${query}\r\n`))
    socket.on('data', (b: Buffer) => {
      chunks.push(b)
      size += b.length
      if (size > MAX_WHOIS_BYTES) finish(null)
    })
    socket.on('end', () => finish(null))
    socket.on('close', () => finish(null))
    socket.on('error', (e) => finish(e))
  })
}

function findReferral(text: string): string | null {
  const m = /^\s*(?:refer|whois):\s*(\S+)\s*$/im.exec(text)
  return m ? m[1]! : null
}

export function createDomainChecker(deps: DomainDeps = {}): Checker<DomainConfig> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson
  const whois = deps.whois ?? defaultWhois
  const now = deps.now ?? Date.now

  async function viaRdap(domain: string, signal: AbortSignal): Promise<Date> {
    const json = await fetchJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`, signal)
    const d = parseRdapExpiry(json)
    if (!d) throw new Error('no expiration event in RDAP response')
    return d
  }

  async function viaWhois(domain: string, signal: AbortSignal): Promise<Date> {
    let server = 'whois.nic.ir'
    if (!domain.endsWith('.ir')) {
      const iana = await whois('whois.iana.org', domain, signal)
      const ref = findReferral(iana)
      if (!ref) throw new Error('no whois server found for TLD')
      server = ref
    }
    const text = await whois(server, domain, signal)
    const d = parseWhoisExpiry(text)
    if (!d) throw new Error(`no expiry date in whois response from ${server}`)
    return d
  }

  return {
    kind: 'domain',
    async run(cfg, signal): Promise<CheckResult> {
      const started = nowMs()
      try {
        const domain = cfg.domain.trim().toLowerCase().replace(/\.$/, '')
        let expires: Date | null = null
        let source: 'rdap' | 'whois' = 'rdap'
        const reasons: string[] = []

        if (!domain.endsWith('.ir')) {
          try {
            expires = await viaRdap(domain, signal)
          } catch (err) {
            if (isAbort(err, signal)) return unknownExpiry(started)
            reasons.push(`rdap: ${errMessage(err)}`)
          }
        }
        if (!expires) {
          source = 'whois'
          try {
            expires = await viaWhois(domain, signal)
          } catch (err) {
            if (isAbort(err, signal)) return unknownExpiry(started)
            reasons.push(`whois: ${errMessage(err)}`)
          }
        }
        const latencyMs = Math.round(nowMs() - started)
        if (!expires) {
          return { status: 'degraded', latencyMs, message: `expiry unknown: ${reasons.join('; ')}` }
        }

        const daysLeft = Math.floor((expires.getTime() - now()) / DAY_MS)
        const meta = { expiresAt: expires.toISOString(), daysLeft, source }
        if (daysLeft < 0) {
          return { status: 'down', latencyMs, message: `domain expired ${-daysLeft} days ago`, meta }
        }
        if (daysLeft < cfg.warn_days) {
          return { status: 'degraded', latencyMs, message: `domain expires in ${daysLeft} days`, meta }
        }
        return { status: 'up', latencyMs, message: `domain expires in ${daysLeft} days`, meta }
      } catch (err) {
        return { status: 'degraded', latencyMs: Math.round(nowMs() - started), message: `expiry unknown: ${errMessage(err)}` }
      }
    },
  }
}

export const domainChecker = createDomainChecker()
