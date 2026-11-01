// Probe -> core transport (docs/PLAN.md "Second vantage"): HMAC-signed JSON with replay protection.
// signature = HMAC-SHA256(secret, `${timestampMs}.${nonce}.${rawBody}`); the timestamp must be within
// SKEW_MS of the verifier's clock and each nonce is accepted once (the nonce store lives in the caller).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const SKEW_MS = 60_000
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_BATCH = 200
export const SIGNATURE_PREFIX = 'v1='

export const H_TIMESTAMP = 'x-pulse-timestamp'
export const H_NONCE = 'x-pulse-nonce'
export const H_SIGNATURE = 'x-pulse-signature'

export const probeResultSchema = z
  .object({
    checkId: z.string().min(1).max(200),
    ts: z.number().int().positive(),
    status: z.enum(['up', 'degraded', 'down']),
    latencyMs: z.number().min(0).max(600_000).optional(),
    message: z.string().max(500).optional(),
  })
  .strict()

export const probeBatchSchema = z
  .object({
    vantage: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    results: z.array(probeResultSchema).min(1).max(MAX_BATCH),
  })
  .strict()

export type ProbeBatch = z.infer<typeof probeBatchSchema>

function mac(secret: string, ts: string, nonce: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest()
}

export function signIngest(secret: string, body: string, now = Date.now(), nonce = randomBytes(16).toString('hex')) {
  const ts = String(now)
  return {
    [H_TIMESTAMP]: ts,
    [H_NONCE]: nonce,
    [H_SIGNATURE]: SIGNATURE_PREFIX + mac(secret, ts, nonce, body).toString('hex'),
  }
}

export type VerifyFailure = 'missing' | 'timestamp' | 'nonce' | 'signature'

/** Stateless part of verification (format, clock skew, signature). The caller then consumes the nonce. */
export function verifyIngest(
  secret: string,
  body: string,
  h: { timestamp?: string | null; nonce?: string | null; signature?: string | null },
  now = Date.now(),
): { ok: true; nonce: string } | { ok: false; reason: VerifyFailure } {
  if (!secret || !h.timestamp || !h.nonce || !h.signature) return { ok: false, reason: 'missing' }
  if (!/^\d{10,16}$/.test(h.timestamp)) return { ok: false, reason: 'timestamp' }
  if (!/^[0-9a-f]{16,64}$/.test(h.nonce)) return { ok: false, reason: 'nonce' }
  if (!h.signature.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: 'signature' }
  const given = Buffer.from(h.signature.slice(SIGNATURE_PREFIX.length), 'hex')
  const expected = mac(secret, h.timestamp, h.nonce, body)
  // signature first: an unauthenticated caller learns nothing about clock or nonce state
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' }
  if (Math.abs(now - Number(h.timestamp)) > SKEW_MS) return { ok: false, reason: 'timestamp' }
  return { ok: true, nonce: h.nonce }
}
