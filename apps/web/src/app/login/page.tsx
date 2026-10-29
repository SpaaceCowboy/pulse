import { AuthError } from 'next-auth'
import { redirect } from 'next/navigation'
import { signIn } from '@/auth'

export const dynamic = 'force-dynamic'

async function login(formData: FormData) {
  'use server'
  try {
    await signIn('credentials', {
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      totp: String(formData.get('totp') ?? ''),
      redirectTo: '/',
    })
  } catch (e) {
    // one message for every failure: wrong password, wrong code, unknown user, rate limited
    if (e instanceof AuthError) redirect('/login?error=1')
    throw e
  }
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams
  const input =
    'w-full rounded-md border border-line bg-surface-2 px-3 py-2.5 text-base text-fg placeholder:text-muted'
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-6 text-2xl font-semibold">Pulse</h1>
      <form action={login} className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1 block text-sm text-muted">
            Email
          </label>
          <input id="email" name="email" type="email" autoComplete="username" required className={input} />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-sm text-muted">
            Password
          </label>
          <input id="password" name="password" type="password" autoComplete="current-password" required className={input} />
        </div>
        <div>
          <label htmlFor="totp" className="mb-1 block text-sm text-muted">
            Authenticator code
          </label>
          <input
            id="totp"
            name="totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            className={input}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-bad">
            Sign-in failed. Check your details and try again.
          </p>
        )}
        <button
          type="submit"
          className="w-full rounded-md bg-ok px-3 py-2.5 text-base font-medium text-bg hover:opacity-90"
        >
          Sign in
        </button>
      </form>
    </main>
  )
}
