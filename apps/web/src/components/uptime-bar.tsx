import { cn } from '@/lib/cn'
import { pct } from '@/lib/format'

const DAY_MS = 86_400_000

/** 90 cells, oldest first, one per UTC day. Hover (title) shows the day and its uptime. */
export function UptimeBar({ days, today }: { days: Array<number | null>; today: number }) {
  const known = days.filter((d): d is number => d !== null)
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null
  const label = avg === null ? 'no uptime data yet' : `${pct(avg)} average over ${known.length} days`
  const start = Math.floor(today / DAY_MS) * DAY_MS - (days.length - 1) * DAY_MS
  return (
    <div role="img" aria-label={`90-day uptime: ${label}`} className="flex h-6 items-stretch gap-px">
      {days.map((d, i) => {
        const date = new Date(start + i * DAY_MS).toISOString().slice(0, 10)
        return (
          <span
            key={i}
            title={d === null ? `${date}: no data` : `${date}: ${pct(d)}`}
            className={cn(
              'w-full min-w-px flex-1 rounded-[1px]',
              d === null ? 'bg-line' : d >= 0.999 ? 'bg-ok' : d >= 0.95 ? 'bg-warn' : 'bg-bad',
            )}
          />
        )
      })}
    </div>
  )
}
