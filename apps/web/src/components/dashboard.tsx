'use client'

import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { applyDiff } from '@/lib/diff'
import { ago } from '@/lib/format'
import type { Snapshot, StreamDiff, TargetView } from '@/lib/types'
import { TargetRow } from './target-row'

const GROUP_ORDER = ['Roco Broker', 'Personal & client projects', 'Infrastructure']

function headline(s: Snapshot['summary'], total: number) {
  if (total === 0) return { text: 'No targets to show', tone: 'text-muted' }
  if (s.down + s.degraded === 0) {
    return s.unknown === total
      ? { text: 'Waiting for the first results', tone: 'text-muted' }
      : { text: 'All systems operational', tone: 'text-ok' }
  }
  const parts = [s.down && `${s.down} down`, s.degraded && `${s.degraded} degraded`].filter(Boolean)
  return { text: parts.join(', '), tone: s.down ? 'text-bad' : 'text-warn' }
}

export function Dashboard({ initial }: { initial: Snapshot }) {
  const [snap, setSnap] = useState(initial)
  const [live, setLive] = useState(false)
  const [now, setNow] = useState(initial.generatedAt)

  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onopen = () => setLive(true)
    es.onerror = () => setLive(false)
    es.addEventListener('snapshot', (e) => setSnap(JSON.parse((e as MessageEvent).data) as Snapshot))
    es.addEventListener('diff', (e) => {
      const diff = JSON.parse((e as MessageEvent).data) as StreamDiff
      setSnap((cur) => applyDiff(cur, diff))
    })
    return () => es.close()
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    setNow(Date.now())
    return () => clearInterval(t)
  }, [])

  const head = headline(snap.summary, snap.targets.length)
  const problems = snap.targets.filter((t) => t.status === 'down' || t.status === 'degraded')

  const groups = useMemo(() => {
    const by = new Map<string, TargetView[]>()
    for (const t of snap.targets) by.set(t.group, [...(by.get(t.group) ?? []), t])
    return [...by.entries()].sort(([a], [b]) => {
      const ia = GROUP_ORDER.indexOf(a)
      const ib = GROUP_ORDER.indexOf(b)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
    })
  }, [snap.targets])

  return (
    <div className="space-y-6">
      <section aria-label="Overall status" className="rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className={cn('text-xl font-semibold sm:text-2xl', head.tone)}>{head.text}</h1>
          <span className="flex items-center gap-2 text-xs text-muted">
            <span
              aria-hidden
              className={cn('size-2 rounded-full', live ? 'live-dot bg-ok' : 'bg-unknown')}
            />
            <span role="status">{live ? 'Live' : 'Reconnecting…'}</span>
          </span>
        </div>
        <p className="mt-1 text-sm text-muted">
          {snap.summary.openIncidents} open {snap.summary.openIncidents === 1 ? 'incident' : 'incidents'} · updated{' '}
          {ago(snap.generatedAt, now)} ago
        </p>
      </section>

      {problems.length > 0 && (
        <section aria-label="Problems" className="rounded-lg border border-bad/40 bg-surface p-4">
          <h2 className="mb-2 text-sm font-medium text-bad">Needs attention</h2>
          <ul className="space-y-1.5 text-sm">
            {problems.map((t) => (
              <li key={t.id} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{t.name}</span>
                <span className="text-muted">
                  {t.problem?.kind}: {t.problem?.message ?? t.status}
                  {t.problem?.since ? ` · since ${ago(t.problem.since, now)} ago` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.map(([group, targets]) => (
        <section key={group} aria-labelledby={`g-${group}`}>
          <h2 id={`g-${group}`} className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">
            {group}
          </h2>
          <ul className="overflow-hidden rounded-lg border border-line bg-surface">
            {targets.map((t) => (
              <TargetRow key={t.id} target={t} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
