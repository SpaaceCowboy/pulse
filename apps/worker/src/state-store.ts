import type { Redis } from 'ioredis'
import type { CheckResult, CheckState } from '@pulse/core'

/** Latest state per check, as served to the status page (Phase 3) and read back by the state machine. */
export interface StoredState {
  state: CheckState
  last: { status: CheckResult['status']; ts: number; latencyMs?: number; message?: string; daysLeft?: number }
}

export class StateStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'pulse:state:',
  ) {}

  async get(checkId: string): Promise<StoredState | null> {
    const raw = await this.redis.get(this.prefix + checkId)
    return raw ? (JSON.parse(raw) as StoredState) : null
  }

  async set(checkId: string, value: StoredState): Promise<void> {
    await this.redis.set(this.prefix + checkId, JSON.stringify(value))
  }
}
