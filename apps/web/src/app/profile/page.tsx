import { redirect } from 'next/navigation'
import { Header } from '@/components/header'
import { createTelegramLinkCode, getTelegramLinkStatus, unlinkTelegram } from '@/server/status'
import { getViewer } from '@/server/viewer'

export const dynamic = 'force-dynamic'

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  const { linked } = await getTelegramLinkStatus(viewer)
  const { code } = await searchParams

  async function generate() {
    'use server'
    const v = await getViewer()
    if (!v) redirect('/login')
    const c = await createTelegramLinkCode(v)
    redirect(`/profile?code=${c.code}`)
  }
  async function unlink() {
    'use server'
    const v = await getViewer()
    if (!v) redirect('/login')
    await unlinkTelegram(v)
    redirect('/profile')
  }

  const btn = 'rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:bg-surface-2'
  return (
    <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
      <Header email={viewer.email} role={viewer.role} active="profile" />
      <h1 className="mb-3 text-xl font-semibold">Profile</h1>
      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="mb-1 text-base font-medium">Telegram alerts</h2>
        <p className="mb-3 text-sm text-muted">
          {linked
            ? 'This account is linked to a Telegram chat. You receive alerts for the targets you can see.'
            : 'Link your Telegram chat to receive alerts for the targets you can see.'}
        </p>
        {code ? (
          <div className="mb-3 text-sm">
            <p className="mb-1">
              Send this to the Pulse bot within 10 minutes:
            </p>
            <code className="block select-all rounded-md bg-surface-2 px-3 py-2 font-mono text-base">/start {code}</code>
          </div>
        ) : null}
        <div className="flex gap-2">
          <form action={generate}>
            <button type="submit" className={btn}>
              {linked ? 'Link a different chat' : 'Generate link code'}
            </button>
          </form>
          {linked ? (
            <form action={unlink}>
              <button type="submit" className={btn}>
                Unlink
              </button>
            </form>
          ) : null}
        </div>
      </section>
    </main>
  )
}
