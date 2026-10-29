import { cn } from '@/lib/cn'
import type { Status } from '@/lib/types'

const STYLE: Record<Status, { dot: string; text: string; label: string }> = {
  up: { dot: 'bg-ok', text: 'text-ok', label: 'Up' },
  degraded: { dot: 'bg-warn', text: 'text-warn', label: 'Degraded' },
  down: { dot: 'bg-bad', text: 'text-bad', label: 'Down' },
  unknown: { dot: 'bg-unknown', text: 'text-muted', label: 'No data' },
}

export function StatusPill({ status, className }: { status: Status; className?: string }) {
  const s = STYLE[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs font-medium',
        s.text,
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  )
}
