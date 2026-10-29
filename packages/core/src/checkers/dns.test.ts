import { describe, expect, it } from 'vitest'
import { createDnsChecker, type DnsResolver } from './dns'
import type { DnsConfig } from './config'

function fake(over: Partial<Record<keyof DnsResolver, unknown>>): DnsResolver {
  const none = async () => {
    throw Object.assign(new Error('nope'), { code: 'ENODATA' })
  }
  return {
    resolve4: none,
    resolve6: none,
    resolveCname: none,
    resolveMx: none,
    resolveTxt: none,
    resolveNs: none,
    ...over,
  } as unknown as DnsResolver
}
const sig = () => new AbortController().signal
const cfg = (c: Partial<DnsConfig> & Pick<DnsConfig, 'type'>): DnsConfig => ({ name: 'example.com', ...c })

describe('dns checker', () => {
  it('A match and mismatch', async () => {
    const c = createDnsChecker(fake({ resolve4: async () => ['1.2.3.4', '5.6.7.8'] }))
    const ok = await c.run(cfg({ type: 'A', expect: ['1.2.3.4'] }), sig())
    expect(ok.status).toBe('up')
    expect(ok.meta).toEqual({ records: ['1.2.3.4', '5.6.7.8'] })
    expect(typeof ok.latencyMs).toBe('number')
    const bad = await c.run(cfg({ type: 'A', expect: ['9.9.9.9'] }), sig())
    expect(bad.status).toBe('down')
  })

  it('expect requires all entries, case-insensitive', async () => {
    const c = createDnsChecker(fake({ resolveNs: async () => ['NS1.Example.com.', 'ns2.example.com.'] }))
    expect((await c.run(cfg({ type: 'NS', expect: ['ns1.example.com', 'NS2.EXAMPLE.COM'] }), sig())).status).toBe('up')
    expect((await c.run(cfg({ type: 'NS', expect: ['ns1.example.com', 'ns3.example.com'] }), sig())).status).toBe('down')
  })

  it('TXT SPF and DMARC contains, chunks joined', async () => {
    const c = createDnsChecker(
      fake({
        resolveTxt: async (name: string) =>
          name.startsWith('_dmarc')
            ? [['v=DMARC1; p=reject;']]
            : [['v=spf1 include:_spf.goo', 'gle.com ~all'], ['other']],
      }),
    )
    const spf = await c.run(cfg({ type: 'TXT', contains: 'include:_spf.google.com' }), sig())
    expect(spf.status).toBe('up')
    expect((spf.meta as { records: string[] }).records[0]).toBe('v=spf1 include:_spf.google.com ~all')
    expect((await c.run(cfg({ type: 'TXT', contains: 'include:mailgun.org' }), sig())).status).toBe('down')
    expect((await c.run({ name: '_dmarc.example.com', type: 'TXT', contains: 'p=reject' }, sig())).status).toBe('up')
    expect((await c.run({ name: '_dmarc.example.com', type: 'TXT', contains: 'p=none' }, sig())).status).toBe('down')
  })

  it('MX normalization', async () => {
    const c = createDnsChecker(fake({ resolveMx: async () => [{ priority: 10, exchange: 'Mail.Example.com.' }] }))
    const r = await c.run(cfg({ type: 'MX', expect: ['10 mail.example.com'] }), sig())
    expect(r.status).toBe('up')
    expect(r.meta).toEqual({ records: ['10 mail.example.com'] })
  })

  it('CNAME strips trailing dot', async () => {
    const c = createDnsChecker(fake({ resolveCname: async () => ['Target.Example.com.'] }))
    const r = await c.run(cfg({ type: 'CNAME', expect: ['target.example.com'] }), sig())
    expect(r.status).toBe('up')
  })

  it('ENOTFOUND is record missing', async () => {
    const c = createDnsChecker(
      fake({
        resolve4: async () => {
          throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' })
        },
      }),
    )
    const r = await c.run(cfg({ type: 'A' }), sig())
    expect(r.status).toBe('down')
    expect(r.message).toBe('record missing')
  })

  it('other errors are down with message, empty is down', async () => {
    const e = createDnsChecker(
      fake({
        resolve6: async () => {
          throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
        },
      }),
    )
    const r = await e.run(cfg({ type: 'AAAA' }), sig())
    expect(r.status).toBe('down')
    expect(r.message).toContain('ECONNREFUSED')
    const empty = createDnsChecker(fake({ resolve4: async () => [] }))
    expect((await empty.run(cfg({ type: 'A' }), sig())).status).toBe('down')
  })

  it('up with no assertions', async () => {
    const c = createDnsChecker(fake({ resolve4: async () => ['1.1.1.1'] }))
    expect((await c.run(cfg({ type: 'A' }), sig())).status).toBe('up')
  })

  it('abort race returns timeout', async () => {
    const c = createDnsChecker(fake({ resolve4: () => new Promise(() => {}) }))
    const r = await c.run(cfg({ type: 'A' }), AbortSignal.timeout(100))
    expect(r.status).toBe('down')
    expect(r.message).toBe('timeout')
    expect(r.latencyMs).toBeGreaterThanOrEqual(50)
  })

  it('already-aborted signal short-circuits', async () => {
    const c = createDnsChecker(fake({ resolve4: async () => ['1.1.1.1'] }))
    const ac = new AbortController()
    ac.abort()
    expect((await c.run(cfg({ type: 'A' }), ac.signal)).message).toBe('timeout')
  })
})
