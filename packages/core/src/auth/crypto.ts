import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import * as OTPAuth from 'otpauth'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEYLEN = 64

/** `scrypt$N$r$p$salt$hash` (base64), so parameters can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, KEYLEN, SCRYPT)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

// ---- TOTP (RFC 6238: SHA-1, 6 digits, 30 s) ----

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32
}

function totp(secret: string, email = 'user'): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'Pulse',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  })
}

export function totpUri(secret: string, email: string): string {
  return totp(secret, email).toString()
}

/**
 * Returns the matched time step (so callers can reject replays of an already-used code) or null.
 * Accepts the previous and next step to tolerate clock skew.
 */
export function verifyTotp(secret: string, code: string, at: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const delta = totp(secret).validate({ token: code, timestamp: at, window: 1 })
  if (delta === null) return null
  return Math.floor(at / 30_000) + delta
}

export function currentTotp(secret: string, at: number = Date.now()): string {
  return totp(secret).generate({ timestamp: at })
}

// ---- API tokens for status.json ----

export const API_TOKEN_PREFIX = 'pls_'

export function generateApiToken(): { token: string; hash: string } {
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashApiToken(token) }
}

/** Tokens are 256-bit random, so a plain SHA-256 is sufficient (and allows an indexed lookup). */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
