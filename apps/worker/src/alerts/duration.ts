export const MIN_MUTE_MS = 60_000
export const MAX_MUTE_MS = 7 * 86_400_000

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** "30m", "2h", "1d" (also "1h30m") -> ms, or null when malformed or outside 1 minute .. 7 days. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase()
  if (!/^(\d+[smhd])+$/.test(s)) return null
  let total = 0
  for (const [, n, u] of s.matchAll(/(\d+)([smhd])/g)) total += Number(n) * UNIT_MS[u!]!
  return total >= MIN_MUTE_MS && total <= MAX_MUTE_MS ? total : null
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return '<1m'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
