import { redirect } from 'next/navigation'
import { Header } from '@/components/header'
import { dateTime, duration } from '@/lib/format'
import { listIncidents } from '@/server/status'
import { getViewer } from '@/server/viewer'

export const dynamic = 'force-dynamic'

export default async function IncidentsPage() {
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  const incidents = await listIncidents(viewer, 200)
  const now = Date.now()
  return (
    <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
      <Header email={viewer.email} role={viewer.role} active="incidents" />
      <h1 className="mb-3 text-xl font-semibold">Incidents</h1>
      {incidents.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">No incidents recorded.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Opened</th>
                <th className="px-3 py-2 font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">Cause</th>
                <th className="px-3 py-2 font-medium">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id} className="border-t border-line align-top">
                  <td className="px-3 py-2">
                    {i.targetName} <span className="font-mono text-xs text-muted">{i.checkKind}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{dateTime(i.openedAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{duration(i.openedAt, i.resolvedAt ?? now)}</td>
                  <td className="px-3 py-2 text-muted">{i.cause ?? '–'}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {i.resolvedAt ? dateTime(i.resolvedAt) : <span className="text-bad">Open</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
