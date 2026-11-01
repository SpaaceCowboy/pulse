import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PORT = 3100
export const E2E_HMAC_SECRET = 'e2e-hmac-secret-0123456789abcdef0123456789abcdef'
export const STATE_FILE = join(tmpdir(), 'pulse-e2e-state.json')

export interface E2eState {
  dbName: string
  base: string
  redisUrl: string
  pids: number[]
  accounts: Record<'admin' | 'user', { email: string; password: string; secret: string; role: string }>
  tokens: { user: string; admin: string }
}
export const readState = (): E2eState => JSON.parse(readFileSync(STATE_FILE, 'utf8'))

export const ADMIN_NAME = 'E2E Admin Secret Proxy'
export const ADMIN_ID = 'e2e-admin-vps'
export const ADMIN_PORT = 4102
export const ROCO_NAME = 'E2E Roco Site'
export const FIXTURE_CONTROL = 'http://127.0.0.1:4100'
export const TELEGRAM_FAKE = 'http://127.0.0.1:4110'
export const SHARED_NAME = 'E2E Shared Infra'
