import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadTargets } from '../targets/load'
import { canSee, scopeTargets, visibleAudiences, type Viewer } from './scope'

const { targets } = loadTargets(fileURLToPath(new URL('../../../../targets.yaml', import.meta.url)))
const admin: Viewer = { role: 'ADMIN' }
const user: Viewer = { role: 'USER' }

describe('scopeTargets', () => {
  it('the registry has both audiences, so these tests are meaningful', () => {
    expect(targets.some((t) => t.audience === 'admin')).toBe(true)
    expect(targets.some((t) => t.audience === 'roco')).toBe(true)
  })

  it('ADMIN sees every target', () => {
    expect(scopeTargets(admin, targets).map((t) => t.id)).toEqual(targets.map((t) => t.id))
  })

  it('USER sees exactly the roco targets and never an admin one', () => {
    const seen = scopeTargets(user, targets)
    expect(seen.map((t) => t.id)).toEqual(targets.filter((t) => t.audience === 'roco').map((t) => t.id))
    expect(seen.some((t) => t.audience === 'admin')).toBe(false)
  })

  it('every individual admin target is hidden from USER', () => {
    for (const t of targets.filter((x) => x.audience === 'admin')) {
      expect(canSee(user, t), t.id).toBe(false)
      expect(scopeTargets(user, [t])).toEqual([])
    }
  })

  it('fails closed: no viewer, unknown role, unknown audience', () => {
    expect(scopeTargets(null, targets)).toEqual([])
    expect(scopeTargets(undefined, targets)).toEqual([])
    expect(scopeTargets({ role: 'GUEST' } as unknown as Viewer, targets)).toEqual([])
    expect(canSee(admin, { audience: 'something-else' })).toBe(false)
    expect(canSee(user, { audience: '' })).toBe(false)
    expect(visibleAudiences(null)).toEqual([])
    expect(visibleAudiences({ role: 'GUEST' } as unknown as Viewer)).toEqual([])
  })

  it('works on joined rows, not just Target objects', () => {
    const rows = [
      { id: 'a', audience: 'roco' },
      { id: 'b', audience: 'admin' },
    ]
    expect(scopeTargets(user, rows)).toEqual([rows[0]])
    expect(visibleAudiences(user)).toEqual(['roco'])
    expect(visibleAudiences(admin)).toEqual(['roco', 'admin'])
  })
})
