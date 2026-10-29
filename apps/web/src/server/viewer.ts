import 'server-only'
import { API_TOKEN_PREFIX, hashApiToken, type Role, type Viewer } from '@pulse/core'
import { findUserById, findUserByTokenHash } from '@pulse/db'
import { auth } from '@/auth'
import { getDb } from './runtime'

export interface SessionViewer extends Viewer {
  id: number
  email: string
}

/**
 * The only way a handler learns who is asking. The role always comes from the users table (never
 * from the cookie), so deleting or demoting a user takes effect on their very next request.
 */
export async function getViewer(): Promise<SessionViewer | null> {
  const session = await auth()
  const id = Number(session?.user?.id)
  if (!Number.isInteger(id) || id <= 0) return null
  const row = await findUserById(getDb(), id)
  return row ? { id: row.id, email: row.email, role: row.role as Role } : null
}

/** Session cookie, or `Authorization: Bearer pls_...` for scripts (status.json only). */
export async function getViewerFromRequest(req: Request): Promise<SessionViewer | null> {
  const header = req.headers.get('authorization')
  if (header) {
    const m = /^Bearer (\S+)$/i.exec(header)
    if (!m || !m[1]!.startsWith(API_TOKEN_PREFIX)) return null
    const row = await findUserByTokenHash(getDb(), hashApiToken(m[1]!))
    return row ? { id: row.id, email: row.email, role: row.role as Role } : null
  }
  return getViewer()
}

/** Re-read a viewer by id (used by the SSE loop so a deleted/demoted user is cut off mid-stream). */
export async function refreshViewer(id: number): Promise<SessionViewer | null> {
  const row = await findUserById(getDb(), id)
  return row ? { id: row.id, email: row.email, role: row.role as Role } : null
}
