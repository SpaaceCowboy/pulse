import { describe, expect, it } from 'vitest'
import { H_NONCE, H_SIGNATURE, H_TIMESTAMP, probeBatchSchema, signIngest, SKEW_MS, verifyIngest } from './ingest'

const secret = 's3cret-s3cret-s3cret-s3cret'
const body = JSON.stringify({ vantage: 'hostvds', results: [{ checkId: 'a:0:http', ts: 1, status: 'up' }] })
const hdr = (h: Record<string, string>) => ({ timestamp: h[H_TIMESTAMP], nonce: h[H_NONCE], signature: h[H_SIGNATURE] })

describe('ingest signing', () => {
  const now = 1_800_000_000_000
  it('accepts a fresh, correctly signed body', () => {
    expect(verifyIngest(secret, body, hdr(signIngest(secret, body, now)), now)).toMatchObject({ ok: true })
  })
  it('rejects a tampered body, wrong secret and missing headers', () => {
    const h = hdr(signIngest(secret, body, now))
    expect(verifyIngest(secret, body + ' ', h, now)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyIngest('other-secret', body, h, now)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyIngest(secret, body, {}, now)).toEqual({ ok: false, reason: 'missing' })
    expect(verifyIngest('', body, h, now)).toEqual({ ok: false, reason: 'missing' })
  })
  it('rejects old and future timestamps beyond the skew window, even when correctly signed', () => {
    const old = hdr(signIngest(secret, body, now - SKEW_MS - 1))
    expect(verifyIngest(secret, body, old, now)).toEqual({ ok: false, reason: 'timestamp' })
    const future = hdr(signIngest(secret, body, now + SKEW_MS + 1))
    expect(verifyIngest(secret, body, future, now)).toEqual({ ok: false, reason: 'timestamp' })
    expect(verifyIngest(secret, body, hdr(signIngest(secret, body, now - SKEW_MS)), now)).toMatchObject({ ok: true })
  })
  it('a signature does not transfer to another timestamp or nonce', () => {
    const h = signIngest(secret, body, now, 'a'.repeat(32))
    expect(verifyIngest(secret, body, { ...hdr(h), timestamp: String(now + 1) }, now)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyIngest(secret, body, { ...hdr(h), nonce: 'b'.repeat(32) }, now)).toEqual({ ok: false, reason: 'signature' })
  })
  it('garbage signatures do not throw', () => {
    const h = hdr(signIngest(secret, body, now))
    for (const signature of ['v1=zz', 'v1=', 'nope', 'v1=' + 'ab'.repeat(100)]) {
      expect(verifyIngest(secret, body, { ...h, signature }, now).ok).toBe(false)
    }
  })
})

describe('probe batch schema', () => {
  it('rejects unknown fields, bad vantage names and empty batches', () => {
    expect(probeBatchSchema.safeParse({ vantage: 'Hostvds', results: [] }).success).toBe(false)
    expect(probeBatchSchema.safeParse({ vantage: 'hostvds', results: [] }).success).toBe(false)
    expect(
      probeBatchSchema.safeParse({ vantage: 'hostvds', results: [{ checkId: 'x', ts: 1, status: 'up', extra: 1 }] }).success,
    ).toBe(false)
    expect(probeBatchSchema.safeParse(JSON.parse(body)).success).toBe(true)
  })
})
