import {
  activeConfigSchemas,
  checkers,
  DEFAULT_INTERVAL_S,
  DEFAULT_TIMEOUT_MS,
  errMessage,
  MAX_TIMEOUT_MS,
  type ActiveKind,
  type CheckResult,
  type Target,
} from '@pulse/core'

export type CheckDef = Target['checks'][number]

export interface CheckRef {
  id: string // see checkId()
  target: Target
  check: CheckDef
  intervalS: number
  timeoutMs: number
}

/** `<target>:<id>` when the check sets `id`, else positional `<target>:<index>:<kind>` (kept so old history survives). */
export const checkId = (target: Target, check: CheckDef, index: number): string =>
  check.id ? `${target.id}:${check.id}` : `${target.id}:${index}:${check.kind}`

/** Where a check runs: targets.yaml `vantage`, default just the core worker. */
export const checkVantages = (ref: Pick<CheckRef, 'check'>): string[] => ref.check.vantage ?? ['core']

/** Passive kinds (heartbeat/agent/queue) are not polled here. */
export function isActive(kind: string): kind is ActiveKind {
  return kind in activeConfigSchemas
}

export function listChecks(targets: Target[]): CheckRef[] {
  return targets.flatMap((target) =>
    target.checks.flatMap((check, i) =>
      isActive(check.kind)
        ? [
            {
              id: checkId(target, check, i),
              target,
              check,
              intervalS: check.interval_s ?? DEFAULT_INTERVAL_S[check.kind],
              timeoutMs: Math.min(check.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
            },
          ]
        : [],
    ),
  )
}

/** Run one check. Never throws: config/registry problems come back as a down result. */
export async function runCheck(ref: CheckRef, outerSignal?: AbortSignal): Promise<CheckResult> {
  const kind = ref.check.kind as ActiveKind
  const checker = checkers[kind]
  if (!checker) return { status: 'down', message: `no checker registered for kind "${kind}"` }
  const cfg = activeConfigSchemas[kind].safeParse(ref.check.config)
  if (!cfg.success) return { status: 'down', message: `invalid config: ${cfg.error.issues[0]?.message}` }
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, AbortSignal.timeout(ref.timeoutMs)])
    : AbortSignal.timeout(ref.timeoutMs)
  try {
    return await checker.run(cfg.data, signal)
  } catch (err) {
    return { status: 'down', message: `checker crashed: ${errMessage(err)}` }
  }
}

/** Placeholder hosts from targets.yaml that must not count as real failures. */
export function isPlaceholder(ref: CheckRef): boolean {
  return JSON.stringify(ref.check.config).includes('.example')
}

/** Heartbeat checks are not polled; the worker turns missed pings into results (heartbeat.ts). */
export function listHeartbeatChecks(targets: Target[]): Array<{ id: string; target: Target; check: CheckDef }> {
  return targets.flatMap((target) =>
    target.checks.flatMap((check, i) =>
      check.kind === 'heartbeat' ? [{ id: checkId(target, check, i), target, check }] : [],
    ),
  )
}
