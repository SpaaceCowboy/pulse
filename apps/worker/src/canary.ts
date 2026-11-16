import { connect } from 'node:net'

// Core connectivity canary. With a single vantage, a network problem on core would otherwise look like every
// target going down at once. Only consulted when a result is not "up", and cached so ten failing checks cost
// one probe round.

export interface Endpoint {
  host: string
  port: number
}
export const CANARY_ENDPOINTS: Endpoint[] = [
  { host: '1.1.1.1', port: 443 },
  { host: '8.8.8.8', port: 443 },
]
const CACHE_MS = 15_000
const PROBE_TIMEOUT_MS = 3_000

export const tcpReachable = (e: Endpoint, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> =>
  new Promise((resolve) => {
    const s = connect({ host: e.host, port: e.port })
    const done = (ok: boolean) => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })

/** true while core can reach at least one canary endpoint. */
export function createCoreOnline(
  opts: { probe?: (e: Endpoint) => Promise<boolean>; endpoints?: Endpoint[]; now?: () => number } = {},
): () => Promise<boolean> {
  const probe = opts.probe ?? tcpReachable
  const endpoints = opts.endpoints ?? CANARY_ENDPOINTS
  const now = opts.now ?? Date.now
  let cached: { at: number; online: Promise<boolean> } | null = null
  return () => {
    if (!cached || now() - cached.at >= CACHE_MS) {
      cached = { at: now(), online: Promise.all(endpoints.map((e) => probe(e))).then((r) => r.some(Boolean)) }
    }
    return cached.online
  }
}
