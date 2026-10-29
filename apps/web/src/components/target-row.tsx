'use client'

import { useState } from 'react'
import { cn } from '@/lib/cn'
import { ago } from '@/lib/format'
import type { TargetDetail, TargetView } from '@/lib/types'
import { Sparkline } from './sparkline'
import { StatusPill } from './status-pill'
import { UptimeBar } from './uptime-bar'

function DaysBadge({ label, days }: { label: string; days: number | null }) {
  if (days === null) return null
  const tone = days < 14 ? 'text-bad' : days < 30 ? 'text-warn' : 'text-muted'
  return (
    <span className={cn('rounded border border-line px-1.5 py-0.5 text-xs tabular-nums', tone)}>
      {label} {days}d
    </span>
  )
}

export function TargetRow({ target, now }: { target: TargetView; now: number }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<TargetDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panelId = `panel-${target.id}`

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next) {
      try {
        const res = await fetch(`/api/targets/${encodeURIComponent(target.id)}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setDetail((await res.json()) as TargetDetail)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load')
      }
    }
  }

  // refresh detail when the live view changes while expanded
  const fresh = detail && open && detail.target.status !== target.status ? null : detail

  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 px-3 py-3 text-left hover:bg-surface-2 sm:grid-cols-[110px_minmax(0,1.2fr)_80px_minmax(0,1.4fr)_auto]"
      >
        <StatusPill status={target.status} />
        <span className="min-w-0">
          <span className="block truncate font-medium">{target.name}</span>
          {target.problem && (
            <span className="block truncate text-xs text-muted">
              {target.problem.kind}: {target.problem.message ?? 'failing'}
              {target.problem.since ? ` · ${ago(target.problem.since, now)}` : ''}
            </span>
          )}
        </span>
        <span className="text-right text-sm tabular-nums text-muted sm:order-3" title="p95 latency, 24 h">
          {target.p95Ms === null ? '–' : `${target.p95Ms} ms`}
        </span>
        <span className="col-span-3 sm:order-4 sm:col-span-1">
          <UptimeBar days={target.days} today={now} />
        </span>
        <span className="col-span-3 flex flex-wrap items-center gap-1.5 sm:order-5 sm:col-span-1 sm:justify-end">
          <DaysBadge label="TLS" days={target.tlsDaysLeft} />
          <DaysBadge label="Domain" days={target.domainDaysLeft} />
          {target.errorCount > 0 && (
            <span className="rounded border border-line px-1.5 py-0.5 text-xs text-bad">{target.errorCount} errors</span>
          )}
        </span>
      </button>

      {open && (
        <div id={panelId} className="space-y-4 bg-surface px-3 pb-4 pt-2">
          {error && <p className="text-sm text-bad">Could not load details ({error}).</p>}
          {!fresh && !error && <p className="text-sm text-muted">Loading…</p>}
          {fresh && (
            <>
              <ul className="space-y-3">
                {fresh.target.checks.map((c) => (
                  <li key={c.id} className="rounded-md border border-line p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-sm">{c.kind}</span>
                      <StatusPill status={c.status} />
                      {c.latencyMs !== null && <span className="text-xs tabular-nums text-muted">{c.latencyMs} ms</span>}
                      {c.daysLeft !== null && <span className="text-xs text-muted">{c.daysLeft} days left</span>}
                      {c.ts && <span className="text-xs text-muted">checked {ago(c.ts, now)} ago</span>}
                    </div>
                    {c.message && c.status !== 'up' && <p className="mt-1 text-sm text-bad">{c.message}</p>}
                    {fresh.sparklines[c.id] && (
                      <div className="mt-2">
                        <Sparkline series={fresh.sparklines[c.id]!} now={now} />
                      </div>
                    )}
                    {(fresh.results[c.id]?.length ?? 0) > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted">Last {fresh.results[c.id]!.length} results</summary>
                        <table className="mt-1 w-full text-xs">
                          <tbody>
                            {fresh.results[c.id]!.map((r, i) => (
                              <tr key={i} className="border-t border-line">
                                <td className="py-1 pr-2 text-muted">{ago(r.ts, now)} ago</td>
                                <td className="pr-2">{r.vantage}</td>
                                <td className="pr-2">{r.status}</td>
                                <td className="pr-2 tabular-nums">{r.latencyMs ?? '–'} ms</td>
                                <td className="truncate text-muted">{r.message}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
              {fresh.incidents.length > 0 && (
                <div>
                  <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Recent incidents</h4>
                  <ul className="space-y-1 text-sm">
                    {fresh.incidents.slice(0, 5).map((i) => (
                      <li key={i.id} className="text-muted">
                        {i.checkKind} · opened {ago(i.openedAt, now)} ago ·{' '}
                        {i.resolvedAt ? `resolved after ${ago(i.openedAt, i.resolvedAt)}` : <span className="text-bad">open</span>}
                        {i.cause ? ` · ${i.cause}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </li>
  )
}
