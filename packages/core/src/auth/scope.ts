import type { Target } from '../targets/schema'

export type Role = 'ADMIN' | 'USER'

export interface Viewer {
  role: Role
}

/** Anything that carries an audience: a loaded Target or a row joined from the targets table. */
export interface Scoped {
  audience: string
}

/**
 * The single authorization rule: ADMIN sees every target, USER only `audience = roco`.
 * Fail closed: an unknown role, a missing viewer or an unknown audience yields nothing.
 */
export function canSee(user: Viewer | null | undefined, item: Scoped): boolean {
  if (!user) return false
  if (user.role === 'ADMIN') return item.audience === 'roco' || item.audience === 'admin'
  if (user.role === 'USER') return item.audience === 'roco'
  return false
}

export function scopeTargets<T extends Scoped = Target>(user: Viewer | null | undefined, targets: readonly T[]): T[] {
  return targets.filter((t) => canSee(user, t))
}

/** Audiences a viewer may read, for SQL `audience = ANY(...)` filters. */
export function visibleAudiences(user: Viewer | null | undefined): Array<'roco' | 'admin'> {
  if (user?.role === 'ADMIN') return ['roco', 'admin']
  if (user?.role === 'USER') return ['roco']
  return []
}
