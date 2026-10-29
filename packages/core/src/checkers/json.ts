import { isDeepStrictEqual } from 'node:util'
import { JSONPath } from 'jsonpath-plus'
import type { CheckResult, Checker } from '../types'
import type { JsonConfig } from './config'
import { httpRequest } from './http'
import { errMessage, isAbort, nowMs, timeoutResult } from './util'

const MAX_ERRORS = 20

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function evalAssertion(doc: unknown, a: JsonConfig['assertions'][number]): string | null {
  let matches: unknown[]
  try {
    matches = JSONPath({ path: a.path, json: doc as object, wrap: true }) as unknown[]
  } catch (err) {
    return `${a.path} (invalid path: ${errMessage(err)})`
  }
  const found = Array.isArray(matches) && matches.length > 0
  if (a.exists !== undefined && found !== a.exists) {
    return `${a.path} (expected ${a.exists ? 'to exist' : 'not to exist'})`
  }
  if (a.equals !== undefined) {
    if (!found) return `${a.path} (missing)`
    if (!isDeepStrictEqual(matches[0], a.equals)) {
      return `${a.path} (expected ${JSON.stringify(a.equals)}, got ${JSON.stringify(matches[0])})`
    }
  }
  return null
}

export const jsonChecker: Checker<JsonConfig> = {
  kind: 'json',
  async run(cfg, signal): Promise<CheckResult> {
    const startedAt = nowMs()
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (cfg.token_header && cfg.token_env) {
        const token = process.env[cfg.token_env]
        if (token) headers[cfg.token_header] = token
      }
      const res = await httpRequest({ url: cfg.url, method: 'GET', max_redirects: cfg.max_redirects }, signal, headers)
      const latencyMs = res.latencyMs

      if (res.status < 200 || res.status >= 300) {
        return { status: 'down', latencyMs, message: `HTTP ${res.status}` }
      }
      let doc: unknown
      try {
        doc = JSON.parse(res.body)
      } catch {
        return { status: 'down', latencyMs, message: 'response is not valid JSON' }
      }

      const meta: Record<string, unknown> = {}
      if (isObj(doc) && doc.version !== undefined) meta.version = doc.version
      let errorCount = 0
      if (isObj(doc) && Array.isArray(doc.errors) && doc.errors.length > 0) {
        errorCount = doc.errors.length
        meta.errors = doc.errors.slice(0, MAX_ERRORS)
      }
      const withMeta = (r: CheckResult): CheckResult => (Object.keys(meta).length ? { ...r, meta } : r)
      const errNote = errorCount ? `; ${errorCount} error(s) reported` : ''

      const failed = cfg.assertions.map((a) => evalAssertion(doc, a)).filter((x): x is string => x !== null)
      if (failed.length) {
        return withMeta({ status: 'down', latencyMs, message: `assertion failed: ${failed.join(', ')}${errNote}` })
      }

      const downChecks: string[] = []
      const degradedChecks: string[] = []
      if (isObj(doc) && isObj(doc.checks)) {
        for (const [name, c] of Object.entries(doc.checks)) {
          const s = isObj(c) ? c.status : undefined
          if (s === 'down') downChecks.push(name)
          else if (s === 'degraded') degradedChecks.push(name)
        }
      }
      if (downChecks.length) {
        return withMeta({ status: 'down', latencyMs, message: `checks down: ${downChecks.join(', ')}${errNote}` })
      }
      if (degradedChecks.length) {
        return withMeta({ status: 'degraded', latencyMs, message: `checks degraded: ${degradedChecks.join(', ')}${errNote}` })
      }
      if (latencyMs > cfg.latency_degraded_ms) {
        return withMeta({ status: 'degraded', latencyMs, message: `slow response: ${latencyMs}ms${errNote}` })
      }
      return withMeta({ status: 'up', latencyMs, ...(errNote ? { message: `ok${errNote}` } : {}) })
    } catch (err) {
      if (isAbort(err, signal)) return timeoutResult(startedAt)
      return { status: 'down', latencyMs: Math.round(nowMs() - startedAt), message: errMessage(err) }
    }
  },
}