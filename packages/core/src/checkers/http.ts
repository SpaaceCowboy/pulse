import { request } from 'undici'
import type { Checker, CheckResult } from '../types'
import type { HttpConfig } from './config'
import { USER_AGENT, errMessage, isAbort, nowMs, raceAbort, timeoutResult } from './util'

const MAX_BODY_BYTES = 1024 * 1024

function discard(body: { on(e: 'error', f: () => void): unknown; destroy(): unknown }) {
  body.on('error', () => {})
  body.destroy()
}

export async function httpRequest(
  cfg: Pick<HttpConfig, 'url' | 'method' | 'max_redirects'>,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  latencyMs: number
  finalUrl: string
}> {
  const started = nowMs()
  let url = cfg.url
  for (let hop = 0; ; hop++) {
    // own controller so the request is torn down when we give up on it via raceAbort
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
    const res = await raceAbort(
      request(url, {
        method: cfg.method,
        headers: { 'user-agent': USER_AGENT, ...extraHeaders },
        signal: ac.signal,
      }),
      signal,
    )
    const location = res.headers.location
    if (res.statusCode >= 300 && res.statusCode < 400 && typeof location === 'string' && location) {
      discard(res.body)
      if (hop >= cfg.max_redirects) throw new Error(`too many redirects (max ${cfg.max_redirects})`)
      url = new URL(location, url).toString()
      continue
    }
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        chunks.push(buf)
        size += buf.length
        if (size >= MAX_BODY_BYTES) {
          discard(res.body)
          break
        }
      }
    } catch (err) {
      if (signal.aborted) throw err
      if (size < MAX_BODY_BYTES) throw err
    }
    const body = Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8')
    return {
      status: res.statusCode,
      headers: res.headers,
      body,
      latencyMs: Math.round(nowMs() - started),
      finalUrl: url,
    }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

export const httpChecker: Checker<HttpConfig> = {
  kind: 'http',
  async run(cfg, signal): Promise<CheckResult> {
    const started = nowMs()
    try {
      const r = await httpRequest(cfg, signal)
      const expected = Array.isArray(cfg.expect_status) ? cfg.expect_status : [cfg.expect_status]
      const meta = { status: r.status, finalUrl: r.finalUrl }
      const base = { latencyMs: r.latencyMs, meta }
      if (r.status >= 500) return { status: 'down', ...base, message: `HTTP ${r.status}` }
      if (!expected.includes(r.status)) {
        const expects2xx = expected.some((s) => s >= 200 && s < 300)
        if (r.status >= 400 && r.status < 500 && expects2xx) {
          return { status: 'degraded', ...base, message: `HTTP ${r.status} (expected ${expected.join('/')})` }
        }
        return { status: 'down', ...base, message: `HTTP ${r.status} (expected ${expected.join('/')})` }
      }
      if (cfg.keyword && !r.body.includes(cfg.keyword)) {
        return { status: 'down', ...base, message: `keyword "${cfg.keyword}" not found` }
      }
      if (r.latencyMs > cfg.latency_degraded_ms) {
        return { status: 'degraded', ...base, message: `slow: ${r.latencyMs}ms > ${cfg.latency_degraded_ms}ms` }
      }
      return { status: 'up', ...base, message: `HTTP ${r.status} in ${r.latencyMs}ms` }
    } catch (err) {
      if (isAbort(err, signal)) return timeoutResult(started)
      return { status: 'down', latencyMs: Math.round(nowMs() - started), message: errMessage(err) }
    }
  },
}
