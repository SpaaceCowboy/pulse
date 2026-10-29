// Forward/backward SQL migrations: migrations/NNNN_name/{up,down}.sql.
// drizzle-kit only generates forward migrations and cannot express the partitioned
// check_results table, so migrations are hand-written and schema.ts is the typed query layer.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

// arbitrary constant; serializes concurrent runners (e.g. two containers booting at once)
const LOCK_ID = 727_001

export interface Migration {
  name: string
  up: string
  down: string
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}_/.test(d.name))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const files = { up: join(dir, name, 'up.sql'), down: join(dir, name, 'down.sql') }
      for (const f of Object.values(files)) {
        if (!existsSync(f)) throw new Error(`migration ${name} is missing ${f} (every migration needs a down path)`)
      }
      return { name, up: readFileSync(files.up, 'utf8'), down: readFileSync(files.down, 'utf8') }
    })
}

async function withLock<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
    await client.query(
      'CREATE TABLE IF NOT EXISTS _pulse_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    return await fn(client)
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {})
    client.release()
  }
}

async function applied(c: pg.PoolClient): Promise<string[]> {
  const r = await c.query<{ name: string }>('SELECT name FROM _pulse_migrations ORDER BY name')
  return r.rows.map((x) => x.name)
}

/** Apply every pending migration in order. Returns the names applied. */
export async function migrateUp(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const all = loadMigrations(dir)
  return withLock(pool, async (c) => {
    const done = new Set(await applied(c))
    const ran: string[] = []
    for (const m of all) {
      if (done.has(m.name)) continue
      await c.query('BEGIN')
      try {
        await c.query(m.up)
        await c.query('INSERT INTO _pulse_migrations (name) VALUES ($1)', [m.name])
        await c.query('COMMIT')
      } catch (err) {
        await c.query('ROLLBACK')
        throw new Error(`migration ${m.name} up failed: ${(err as Error).message}`)
      }
      ran.push(m.name)
    }
    return ran
  })
}

/** Roll back the last `steps` applied migrations, newest first. Returns the names reverted. */
export async function migrateDown(pool: pg.Pool, steps = 1, dir = MIGRATIONS_DIR): Promise<string[]> {
  const byName = new Map(loadMigrations(dir).map((m) => [m.name, m]))
  return withLock(pool, async (c) => {
    const toRevert = (await applied(c)).reverse().slice(0, steps)
    for (const name of toRevert) {
      const m = byName.get(name)
      if (!m) throw new Error(`applied migration ${name} has no files on disk`)
      await c.query('BEGIN')
      try {
        await c.query(m.down)
        await c.query('DELETE FROM _pulse_migrations WHERE name = $1', [name])
        await c.query('COMMIT')
      } catch (err) {
        await c.query('ROLLBACK')
        throw new Error(`migration ${name} down failed: ${(err as Error).message}`)
      }
    }
    return toRevert
  })
}

export async function migrationStatus(pool: pg.Pool, dir = MIGRATIONS_DIR) {
  const all = loadMigrations(dir)
  return withLock(pool, async (c) => {
    const done = new Set(await applied(c))
    return all.map((m) => ({ name: m.name, applied: done.has(m.name) }))
  })
}
