import 'server-only'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { z } from 'zod'
import { hashPassword, verifyPassword, verifyTotp } from '@pulse/core'
import { claimTotpStep, findUserByEmail } from '@pulse/db'
import { clearFailures, recordFailure, tooManyFailures } from '@/server/rate-limit'
import { getDb } from '@/server/runtime'

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^\d{6}$/),
})

// Verified against when the email is unknown, so "no such user" costs the same as "wrong password".
const DUMMY_HASH = hashPassword('pulse-dummy-password')

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  session: { strategy: 'jwt', maxAge: 12 * 60 * 60 },
  pages: { signIn: '/login' },
  callbacks: {
    // the JWT subject is the users.id; the role is deliberately NOT copied in (see server/viewer.ts)
    session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub
      return session
    },
  },
  providers: [
    Credentials({
      credentials: { email: {}, password: {}, totp: {} },
      async authorize(raw, request) {
        const parsed = credentialsSchema.safeParse(raw)
        if (!parsed.success) return null
        const { email, password, totp } = parsed.data
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
        const keys = [`email:${email.toLowerCase()}`, `ip:${ip}`]
        if (await tooManyFailures(keys)) return null

        const db = getDb()
        const user = await findUserByEmail(db, email)
        const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH))
        // TOTP is mandatory: an account without a secret cannot sign in at all.
        const step = user?.totpSecret ? verifyTotp(user.totpSecret, totp) : null
        if (!user || !passwordOk || step === null || !(await claimTotpStep(db, user.id, step))) {
          await recordFailure(keys)
          return null
        }
        await clearFailures(keys)
        return { id: String(user.id), email: user.email }
      },
    }),
  ],
})
