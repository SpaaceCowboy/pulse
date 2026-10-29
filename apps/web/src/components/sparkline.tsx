const COLORS = ['var(--color-ok)', '#6aa8ff', '#c48bff', '#ffb36a']

/** One polyline per vantage over the last 24 h. Points are [epoch ms, ms]. */
export function Sparkline({ series, now }: { series: Record<string, Array<[number, number]>>; now: number }) {
  const W = 240
  const H = 36
  const entries = Object.entries(series)
  const all = entries.flatMap(([, pts]) => pts)
  if (all.length < 2) return <span className="text-xs text-muted">not enough data</span>
  const max = Math.max(...all.map((p) => p[1]), 1)
  const t1 = now
  const t0 = now - 24 * 3_600_000
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W
  const y = (v: number) => H - 2 - (v / max) * (H - 4)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`24 hour latency, peak ${max} ms`}>
        {entries.map(([vantage, pts], i) => (
          <polyline
            key={vantage}
            fill="none"
            stroke={COLORS[i % COLORS.length]}
            strokeWidth="1.5"
            strokeLinejoin="round"
            points={pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
          />
        ))}
      </svg>
      <ul className="flex gap-3 text-xs text-muted">
        {entries.map(([vantage], i) => (
          <li key={vantage} className="flex items-center gap-1">
            <span aria-hidden className="size-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
            {vantage}
          </li>
        ))}
        <li>peak {max} ms</li>
      </ul>
    </div>
  )
}
