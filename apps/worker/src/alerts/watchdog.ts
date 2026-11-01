// Watchdog for the watcher: ping an external monitor (Healthchecks.io style GET) every minute while Pulse is
// healthy. If Pulse dies, its database or Redis goes away, or the scheduler stops producing results, the pings
// stop and the external monitor alerts.
export const WATCHDOG_INTERVAL_MS = 60_000
const MAX_RESULT_AGE_MS = 5 * 60_000

export interface WatchdogDeps {
  url: string
  /** db + redis reachable */
  healthy: () => Promise<boolean>
  /** epoch ms of the last stored check result; null when the scheduler is disabled */
  lastResultAt: () => number | null
  log?: (m: string) => void
  intervalMs?: number
}

export async function pingOnce(d: WatchdogDeps, now = Date.now()): Promise<boolean> {
  try {
    if (!(await d.healthy())) {
      d.log?.('watchdog: db/redis unhealthy, not pinging')
      return false
    }
    const last = d.lastResultAt()
    if (last !== null && now - last > MAX_RESULT_AGE_MS) {
      d.log?.('watchdog: scheduler stalled, not pinging')
      return false
    }
    const res = await fetch(d.url, { headers: { 'user-agent': 'PulseMonitor/1.0' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) d.log?.(`watchdog: monitor answered ${res.status}`)
    return res.ok
  } catch (err) {
    d.log?.(`watchdog: ping failed: ${(err as Error).message}`)
    return false
  }
}

export function startWatchdog(d: WatchdogDeps) {
  const timer = setInterval(() => void pingOnce(d), d.intervalMs ?? WATCHDOG_INTERVAL_MS)
  void pingOnce(d)
  return { close: () => clearInterval(timer) }
}
