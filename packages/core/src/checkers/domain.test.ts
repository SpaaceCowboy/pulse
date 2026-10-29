import { describe, expect, it, vi } from 'vitest'
import { createDomainChecker, parseRdapExpiry, parseWhoisExpiry } from './domain'

const NOW = Date.parse('2026-06-01T00:00:00Z')
const rdap = (date: string) => ({
  objectClassName: 'domain',
  ldhName: 'example.com',
  events: [
    { eventAction: 'registration', eventDate: '2000-01-01T00:00:00Z' },
    { eventAction: 'expiration', eventDate: date },
    { eventAction: 'last changed', eventDate: '2025-01-01T00:00:00Z' },
  ],
})
const sig = () => new AbortController().signal
const cfg = (domain: string, warn_days = 30) => ({ domain, warn_days })

describe('parsers', () => {
  it('parses RDAP expiration', () => {
    expect(parseRdapExpiry(rdap('2027-01-01T12:00:00Z'))?.toISOString()).toBe('2027-01-01T12:00:00.000Z')
    expect(parseRdapExpiry({ events: [{ eventAction: 'registration', eventDate: '2000-01-01T00:00:00Z' }] })).toBeNull()
    expect(parseRdapExpiry(null)).toBeNull()
    expect(parseRdapExpiry({})).toBeNull()
  })
  it('parses .ir whois', () => {
    const text = '% nic.ir whois\ndomain:\t\trocobroker.ir\nascii:\t\trocobroker.ir\nlast-updated:\t2025-05-01\nexpire-date:\t2027-01-01\nnserver:\tns1.example.com\n'
    expect(parseWhoisExpiry(text)?.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
  it('parses verisign style', () => {
    const text = 'Domain Name: EXAMPLE.COM\r\nRegistry Expiry Date: 2028-08-13T04:00:00Z\r\nRegistrar: X\r\n'
    expect(parseWhoisExpiry(text)?.toISOString()).toBe('2028-08-13T04:00:00.000Z')
  })
  it('parses other key variants', () => {
    expect(parseWhoisExpiry('Expiration Date: 2027-03-04')?.toISOString()).toBe('2027-03-04T00:00:00.000Z')
    expect(parseWhoisExpiry('paid-till: 2026.12.31')?.toISOString()).toBe('2026-12-31T00:00:00.000Z')
    expect(parseWhoisExpiry('nothing here')).toBeNull()
  })
})

describe('domain checker', () => {
  it('up / degraded / down thresholds', async () => {
    const mk = (date: string) => createDomainChecker({ now: () => NOW, fetchJson: async () => rdap(date) })
    const up = await mk('2026-12-01T00:00:00Z').run(cfg('example.com'), sig())
    expect(up.status).toBe('up')
    expect(up.meta).toMatchObject({ source: 'rdap', daysLeft: 183, expiresAt: '2026-12-01T00:00:00.000Z' })
    const deg = await mk('2026-06-11T00:00:00Z').run(cfg('example.com'), sig())
    expect(deg.status).toBe('degraded')
    expect(deg.meta).toMatchObject({ daysLeft: 10 })
    const down = await mk('2026-05-20T00:00:00Z').run(cfg('example.com'), sig())
    expect(down.status).toBe('down')
    expect((down.meta as { daysLeft: number }).daysLeft).toBeLessThan(0)
  })

  it('falls back to whois via IANA referral when RDAP fails', async () => {
    const whois = vi.fn(async (server: string, _q: string, _s: AbortSignal) =>
      server === 'whois.iana.org' ? 'refer:        whois.verisign-grs.com\n' : 'Registry Expiry Date: 2027-01-01T00:00:00Z\n',
    )
    const c = createDomainChecker({
      now: () => NOW,
      fetchJson: async () => {
        throw new Error('boom')
      },
      whois,
    })
    const r = await c.run(cfg('example.com'), sig())
    expect(r.status).toBe('up')
    expect(r.meta).toMatchObject({ source: 'whois' })
    expect(whois).toHaveBeenNthCalledWith(2, 'whois.verisign-grs.com', 'example.com', expect.anything())
  })

  it('.ir goes straight to whois.nic.ir', async () => {
    const fetchJson = vi.fn()
    const whois = vi.fn(async (_s: string, _q: string, _sig: AbortSignal) => 'expire-date: 2026-06-11\n')
    const r = await createDomainChecker({ now: () => NOW, fetchJson, whois }).run(cfg('rocobroker.ir'), sig())
    expect(fetchJson).not.toHaveBeenCalled()
    expect(whois).toHaveBeenCalledTimes(1)
    expect(whois).toHaveBeenCalledWith('whois.nic.ir', 'rocobroker.ir', expect.anything())
    expect(r.status).toBe('degraded')
    expect(r.meta).toMatchObject({ source: 'whois', daysLeft: 10 })
  })

  it('both sources failing -> degraded expiry unknown', async () => {
    const c = createDomainChecker({
      now: () => NOW,
      fetchJson: async () => {
        throw new Error('rate limited')
      },
      whois: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const r = await c.run(cfg('example.com'), sig())
    expect(r.status).toBe('degraded')
    expect(r.message).toMatch(/^expiry unknown: /)
    expect(r.message).toContain('rate limited')
  })

  it('unparseable data -> degraded expiry unknown', async () => {
    const c = createDomainChecker({ fetchJson: async () => ({ events: [] }), whois: async () => 'refer: x.example\n' })
    const r = await c.run(cfg('example.com'), sig())
    expect(r.status).toBe('degraded')
    expect(r.message).toMatch(/^expiry unknown: /)
  })

  it('abort returns timeout without falling back', async () => {
    const ac = new AbortController()
    const whois = vi.fn(async (_s: string, _q: string, _sig: AbortSignal) => '')
    const c = createDomainChecker({
      fetchJson: async (_u, s) => {
        ac.abort()
        if (s.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        return {}
      },
      whois,
    })
    const r = await c.run(cfg('example.com'), ac.signal)
    expect(r).toMatchObject({ status: 'degraded', message: 'expiry unknown: timeout' })
    expect(whois).not.toHaveBeenCalled()
  })
})
