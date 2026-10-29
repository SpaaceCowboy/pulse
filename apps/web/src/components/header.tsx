import Link from 'next/link'
import { cn } from '@/lib/cn'
import { signOut } from '@/auth'

export function Header({ email, role, active }: { email: string; role: string; active: 'status' | 'incidents' }) {
  const tab = (on: boolean) =>
    cn('rounded-md px-3 py-1.5 text-sm', on ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg')
  return (
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <nav aria-label="Primary" className="flex items-center gap-1">
        <span className="mr-3 text-lg font-semibold">Pulse</span>
        <Link href="/" className={tab(active === 'status')} aria-current={active === 'status' ? 'page' : undefined}>
          Status
        </Link>
        <Link
          href="/incidents"
          className={tab(active === 'incidents')}
          aria-current={active === 'incidents' ? 'page' : undefined}
        >
          Incidents
        </Link>
      </nav>
      <form
        action={async () => {
          'use server'
          await signOut({ redirectTo: '/login' })
        }}
        className="flex items-center gap-3 text-xs text-muted"
      >
        <span className="hidden sm:inline">
          {email} · {role}
        </span>
        <button type="submit" className="rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:bg-surface-2">
          Sign out
        </button>
      </form>
    </header>
  )
}
