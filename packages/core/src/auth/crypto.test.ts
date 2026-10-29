import { describe, expect, it } from 'vitest'
import {
  currentTotp,
  generateApiToken,
  generateTotpSecret,
  hashApiToken,
  hashPassword,
  totpUri,
  verifyPassword,
  verifyTotp,
} from './crypto'

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const h = await hashPassword('correct horse battery')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
  })
  it('salts: same password hashes differently', async () => {
    expect(await hashPassword('same-password-1')).not.toBe(await hashPassword('same-password-1'))
  })
  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', '')).toBe(false)
    expect(await verifyPassword('x', 'plain')).toBe(false)
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false)
  })
})

describe('totp', () => {
  const secret = generateTotpSecret()
  const t0 = Date.UTC(2026, 9, 29, 12, 0, 0)

  it('accepts the current code and returns its step', () => {
    expect(verifyTotp(secret, currentTotp(secret, t0), t0)).toBe(Math.floor(t0 / 30_000))
  })
  it('tolerates one step of skew either way, not two', () => {
    expect(verifyTotp(secret, currentTotp(secret, t0 - 30_000), t0)).toBe(Math.floor(t0 / 30_000) - 1)
    expect(verifyTotp(secret, currentTotp(secret, t0 + 30_000), t0)).toBe(Math.floor(t0 / 30_000) + 1)
    expect(verifyTotp(secret, currentTotp(secret, t0 - 90_000), t0)).toBeNull()
  })
  it('rejects wrong or malformed codes', () => {
    expect(verifyTotp(secret, '000000', t0) === null || currentTotp(secret, t0) === '000000').toBe(true)
    expect(verifyTotp(secret, 'abcdef', t0)).toBeNull()
    expect(verifyTotp(secret, '12345', t0)).toBeNull()
    expect(verifyTotp(secret, '', t0)).toBeNull()
  })
  it('builds an otpauth URI', () => {
    expect(totpUri(secret, 'a@b.c')).toMatch(/^otpauth:\/\/totp\/Pulse:a%40b\.c\?.*secret=/)
  })
})

describe('api tokens', () => {
  it('stores only a hash that matches the token', () => {
    const { token, hash } = generateApiToken()
    expect(token.startsWith('pls_')).toBe(true)
    expect(hash).toBe(hashApiToken(token))
    expect(hash).not.toContain(token)
    expect(generateApiToken().token).not.toBe(token)
  })
})
