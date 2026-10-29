import type { CheckResult } from '../types'

export const USER_AGENT = 'PulseMonitor/1.0'
export const MAX_TIMEOUT_MS = 10_000
export const DEFAULT_TIMEOUT_MS = 10_000

export function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}

/** True if the error came from the abort signal (timeout or caller abort). */
export function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
}

/**
 * Reject as soon as `signal` aborts, even if `p` (e.g. an undici request stuck in a DNS lookup)
 * does not honor the signal promptly. `p`'s later rejection is swallowed.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => {})
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (signal.aborted) return fail()
    signal.addEventListener('abort', fail, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', fail)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', fail)
        reject(e)
      },
    )
  })
}

/** Build the standard result for an aborted/timed-out check. */
export function timeoutResult(startedAt: number): CheckResult {
  return { status: 'down', latencyMs: Math.round(performance.now() - startedAt), message: 'timeout' }
}

export const nowMs = () => performance.now()

/** Whole days between now and a future date (negative if past). */
export function daysUntil(date: Date, now = Date.now()): number {
  return Math.floor((date.getTime() - now) / 86_400_000)
}
