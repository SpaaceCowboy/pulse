import 'server-only'
import { getRedis } from './runtime'

const WINDOW_S = 15 * 60
export const MAX_FAILURES = 5

/** Failed-login counters per key (email, ip). Fails open if Redis is down: auth still checks credentials. */
export async function tooManyFailures(keys: string[]): Promise<boolean> {
  try {
    const counts = await Promise.all(keys.map((k) => getRedis().get(`pulse:login-fail:${k}`)))
    return counts.some((c) => Number(c ?? 0) >= MAX_FAILURES)
  } catch {
    return false
  }
}

export async function recordFailure(keys: string[]): Promise<void> {
  try {
    const r = getRedis()
    for (const k of keys) {
      const key = `pulse:login-fail:${k}`
      if ((await r.incr(key)) === 1) await r.expire(key, WINDOW_S)
    }
  } catch {
    /* see above */
  }
}

export async function clearFailures(keys: string[]): Promise<void> {
  try {
    await getRedis().del(...keys.map((k) => `pulse:login-fail:${k}`))
  } catch {
    /* see above */
  }
}
