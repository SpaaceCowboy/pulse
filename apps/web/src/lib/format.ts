export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export const duration = (from: number, to: number) => ago(from, to)

export function dateTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export const pct = (ratio: number) => `${(ratio * 100).toFixed(ratio === 1 || ratio === 0 ? 0 : 2)}%`
