export interface CheckResult {
  status: 'up' | 'degraded' | 'down'
  latencyMs?: number
  message?: string
  meta?: Record<string, unknown>
}

export interface Checker<C> {
  kind: string
  run(cfg: C, signal: AbortSignal): Promise<CheckResult>
}
