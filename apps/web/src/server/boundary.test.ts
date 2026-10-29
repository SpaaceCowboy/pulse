// Architecture guard: no handler may read targets/results/Redis except through server/status.ts, and every
// non-public route/page must resolve a viewer. Fails the build if someone bypasses scopeTargets.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const files = walk(SRC)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ path: relative(SRC, f).split(sep).join('/'), text: readFileSync(f, 'utf8') }))

// Modules that can reach data. Only these files may import them.
const DATA_IMPORT = /from\s+['"](@pulse\/db|ioredis|pg|drizzle-orm|@pulse\/core\/[^'"]*)['"]|\bloadTargets\b|\bparseTargets\b|targets\.yaml/
const ALLOWED_DATA = new Set(['auth.ts', 'server/runtime.ts', 'server/status.ts', 'server/viewer.ts', 'server/rate-limit.ts'])

describe('data-access boundary', () => {
  it('only the server/ data modules and auth.ts import the db, redis or the targets loader', () => {
    const offenders = files.filter((f) => !ALLOWED_DATA.has(f.path) && DATA_IMPORT.test(f.text)).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('server/runtime.ts getDb/getRedis are only used by the allowed modules', () => {
    const offenders = files
      .filter((f) => !ALLOWED_DATA.has(f.path) && /\b(getDb|getRedis)\b/.test(f.text))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('every exported status.ts function takes the viewer as its first argument', () => {
    const text = files.find((f) => f.path === 'server/status.ts')!.text
    const exported = [...text.matchAll(/export (?:async )?function (\w+)\(([^)]*)/g)]
    expect(exported.length).toBeGreaterThan(0)
    for (const [, name, params] of exported) {
      if (name === 'summarize') continue // pure aggregation over already-scoped views
      expect(params, name).toMatch(/^viewer: Viewer/)
    }
  })
})

const PUBLIC_HANDLERS = new Set([
  'app/api/healthz/route.ts',
  'app/api/auth/[...nextauth]/route.ts',
  'app/robots.txt/route.ts',
  'app/login/page.tsx',
  'app/layout.tsx',
])

describe('every handler authenticates', () => {
  const handlers = files.filter((f) => /^app\/.*\/?(route\.ts|page\.tsx)$/.test(f.path) && !PUBLIC_HANDLERS.has(f.path))

  it('there are handlers to check', () => {
    expect(handlers.map((h) => h.path)).toEqual(
      expect.arrayContaining(['app/page.tsx', 'app/api/status.json/route.ts', 'app/api/stream/route.ts']),
    )
  })

  it.each(handlers.map((h) => [h.path, h.text] as const))('%s resolves a viewer and reads data only via status.ts', (_path, text) => {
    expect(text).toMatch(/getViewer(FromRequest)?\(/)
    expect(text).toMatch(/\b(getSnapshot|getTargetDetail|listIncidents)\(\s*(viewer|v)\b/)
  })
})
