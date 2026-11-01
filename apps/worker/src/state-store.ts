import type { Redis } from 'ioredis'
import type { CheckResult, CheckState } from '@pulse/core'

/** Latest state per check, as served to the status page (Phase 3) and read back by the state machine. */
export interface StoredState {
  state: CheckState
  last: { status: CheckResult['status']; ts: number; latencyMs?: number; message?: string; daysLeft?: number }
}

/** Latest result of one vantage for one check. Probes write these through /api/ingest, core writes its own. */
export interface VantageEntry {
  status: CheckResult['status']
  ts: number
  message?: string
}

export const VANTAGE_PREFIX = 'pulse:vantage:'

export class StateStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'pulse:state:',
    private readonly vantagePrefix = VANTAGE_PREFIX,
  ) {}

  async get(checkId: string): Promise<StoredState | null> {
    const raw = await this.redis.get(this.prefix + checkId)
    return raw ? (JSON.parse(raw) as StoredState) : null
  }

  async set(checkId: string, value: StoredState): Promise<void> {
    await this.redis.set(this.prefix + checkId, JSON.stringify(value))
  }

  async setVantage(checkId: string, vantage: string, entry: VantageEntry): Promise<void> {
    const key = this.vantagePrefix + checkId
    await this.redis.multi().hset(key, vantage, JSON.stringify(entry)).expire(key, 86_400).exec()
  }

  async getVantages(checkId: string): Promise<Record<string, VantageEntry>> {
    const raw = await this.redis.hgetall(this.vantagePrefix + checkId)
    const out: Record<string, VantageEntry> = {}
    for (const [v, json] of Object.entries(raw)) {
      try {
        out[v] = JSON.parse(json) as VantageEntry
      } catch {
        /* ignore a corrupt entry: that vantage simply counts as absent */
      }
    }
    return out
  }
}
