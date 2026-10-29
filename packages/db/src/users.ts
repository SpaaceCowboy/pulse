import { eq, sql } from 'drizzle-orm'
import type { Db } from './store'
import { users } from './schema'

export type UserRow = typeof users.$inferSelect

const norm = (email: string) => email.trim().toLowerCase()

export async function createUser(
  db: Db,
  u: { email: string; passwordHash: string; totpSecret: string; role: 'ADMIN' | 'USER' },
): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({ email: norm(u.email), passwordHash: u.passwordHash, totpSecret: u.totpSecret, role: u.role })
    .returning()
  return row!
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.email, norm(email))).limit(1)
  return row ?? null
}

export async function findUserById(db: Db, id: number): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return row ?? null
}

export async function findUserByTokenHash(db: Db, hash: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.apiTokenHash, hash)).limit(1)
  return row ?? null
}

export async function listUsers(db: Db): Promise<UserRow[]> {
  return db.select().from(users).orderBy(users.id)
}

export async function updateUser(
  db: Db,
  email: string,
  patch: Partial<Pick<UserRow, 'role' | 'totpSecret' | 'totpLastStep' | 'apiTokenHash' | 'passwordHash'>>,
): Promise<UserRow | null> {
  const [row] = await db.update(users).set(patch).where(eq(users.email, norm(email))).returning()
  return row ?? null
}

/**
 * Atomically claim a TOTP time step; false if it was already used (replay) or older.
 * Single UPDATE so two concurrent logins with the same code cannot both succeed.
 */
export async function claimTotpStep(db: Db, userId: number, step: number): Promise<boolean> {
  const res = await db.execute<{ id: number }>(
    sql`UPDATE users SET totp_last_step = ${step} WHERE id = ${userId} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`,
  )
  return res.rows.length === 1
}

export async function deleteUser(db: Db, email: string): Promise<boolean> {
  const rows = await db.delete(users).where(eq(users.email, norm(email))).returning({ id: users.id })
  return rows.length === 1
}
