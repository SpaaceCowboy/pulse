import { promises as dnsPromises } from 'node:dns'
import type { Checker, CheckResult } from '../types'
import type { DnsConfig } from './config'
import { errMessage, nowMs, timeoutResult } from './util'

export type DnsResolver = Pick<
  dnsPromises.Resolver,
  'resolve4' | 'resolve6' | 'resolveCname' | 'resolveMx' | 'resolveTxt' | 'resolveNs'
>

const stripDot = (s: string) => s.replace(/\.$/, '').toLowerCase()

async function lookup(resolver: DnsResolver, cfg: DnsConfig): Promise<string[]> {
  switch (cfg.type) {
    case 'A':
      return (await resolver.resolve4(cfg.name)).map((s) => s.toLowerCase())
    case 'AAAA':
      return (await resolver.resolve6(cfg.name)).map((s) => s.toLowerCase())
    case 'CNAME':
      return (await resolver.resolveCname(cfg.name)).map(stripDot)
    case 'NS':
      return (await resolver.resolveNs(cfg.name)).map(stripDot)
    case 'MX':
      return (await resolver.resolveMx(cfg.name)).map((m) => `${m.priority} ${stripDot(m.exchange)}`)
    case 'TXT':
      return (await resolver.resolveTxt(cfg.name)).map((chunks) => chunks.join(''))
  }
}

export function createDnsChecker(resolver: DnsResolver = new dnsPromises.Resolver()): Checker<DnsConfig> {
  return {
    kind: 'dns',
    async run(cfg, signal): Promise<CheckResult> {
      const started = nowMs()
      const elapsed = () => Math.round(nowMs() - started)
      if (signal.aborted) return timeoutResult(started)

      let onAbort: (() => void) | undefined
      const aborted = new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted')
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const outcome = await Promise.race([
          lookup(resolver, cfg).then(
            (records) => ({ records }),
            (error: unknown) => ({ error }),
          ),
          aborted,
        ])
        if (outcome === 'aborted') return timeoutResult(started)
        if ('error' in outcome) {
          const code = (outcome.error as NodeJS.ErrnoException | undefined)?.code
          const message =
            code === 'ENOTFOUND' || code === 'ENODATA' ? 'record missing' : errMessage(outcome.error)
          return { status: 'down', latencyMs: elapsed(), message }
        }
        const { records } = outcome
        const meta = { records }
        if (records.length === 0) {
          return { status: 'down', latencyMs: elapsed(), message: 'record missing', meta }
        }
        const lower = records.map((r) => r.toLowerCase())
        const missing = (cfg.expect ?? []).filter((e) => !lower.includes(e.toLowerCase()))
        if (missing.length > 0) {
          return { status: 'down', latencyMs: elapsed(), message: `missing expected: ${missing.join(', ')}`, meta }
        }
        if (cfg.contains !== undefined) {
          const needle = cfg.contains.toLowerCase()
          if (!lower.some((r) => r.includes(needle))) {
            return { status: 'down', latencyMs: elapsed(), message: `no record contains "${cfg.contains}"`, meta }
          }
        }
        return { status: 'up', latencyMs: elapsed(), meta }
      } catch (err) {
        return { status: 'down', latencyMs: elapsed(), message: errMessage(err) }
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort)
      }
    },
  }
}

export const dnsChecker: Checker<DnsConfig> = createDnsChecker()
