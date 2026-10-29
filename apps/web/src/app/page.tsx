import { redirect } from 'next/navigation'
import { Dashboard } from '@/components/dashboard'
import { Header } from '@/components/header'
import { getSnapshot } from '@/server/status'
import { getViewer } from '@/server/viewer'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  // Scoped here, on the server: a USER's HTML is rendered from this snapshot and contains nothing else.
  const snapshot = await getSnapshot(viewer)
  return (
    <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
      <Header email={viewer.email} role={viewer.role} active="status" />
      <Dashboard initial={snapshot} />
    </main>
  )
}
