// Integration tests: need TEST_DATABASE_URL (run with `pnpm test:db`); skipped otherwise.
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from './schema'
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from './migrate'
import {
  closeIncident,
  dropOldPartitions,
  ensurePartitions,
  hasOpenIncident,
  insertResult,
  openIncident,
  rollupHour,
  syncTargets,
  type SyncTarget,
} from './store'
import { createTestDb, TEST_DATABASE_URL } from './testing'
import { sql } from 'drizzle-orm'
import { claimTotpStep, createUser, findUserByEmail, findUserByTokenHash, updateUser } from './users'

const NOW = new Date('2026-10-29T12:30:00Z')

describe('migration files', () => {
  it('every migration has a non-empty up and down', () => {
    const ms = loadMigrations()
    expect(ms.length).toBeGreaterThan(0)
    for (const m of ms) {
      expect(m.up.trim(), m.name).not.toBe('')
      expect(m.down.trim(), m.name).not.toBe('')
    }
  })
})

describe.skipIf(!TEST_DATABASE_URL)('postgres', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>

  const leftovers = async () => {
    const tables = await t.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_pulse_migrations' ORDER BY 1",
    )
    const types = await t.pool.query(
      "SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'",
    )
    return { tables: tables.rows.map((r) => r.tablename), types: types.rows.map((r) => r.typname) }
  }

  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(async () => {
    await t?.drop()
  })

  it('migrates up -> down -> up', async () => {
    const names = loadMigrations().map((m) => m.name)

    expect(await migrateUp(t.pool)).toEqual(names)
    const first = await leftovers()
    expect(first.tables).toContain('check_results')
    expect(first.tables).toContain('check_results_default')
    expect(await migrateUp(t.pool)).toEqual([]) // idempotent

    expect(await migrateDown(t.pool, names.length)).toEqual([...names].reverse())
    expect(await leftovers()).toEqual({ tables: [], types: [] })
    expect((await migrationStatus(t.pool)).every((m) => !m.applied)).toBe(true)

    expect(await migrateUp(t.pool)).toEqual(names)
    expect(await leftovers()).toEqual(first)
  })

  it('schema.ts matches the migrated database (column names)', async () => {
    for (const value of Object.values(schema)) {
      if (!(value instanceof PgTable)) continue
      const cfg = getTableConfig(value)
      const r = await t.pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [cfg.name],
      )
      expect(r.rows.map((x) => x.column_name).sort(), cfg.name).toEqual(cfg.columns.map((c) => c.name).sort())
    }
  })

  it('syncs targets and checks, removing what left the registry', async () => {
    const mk = (id: string, checkIds: string[]): SyncTarget => ({
      id,
      name: id,
      group: 'g',
      audience: 'roco',
      tags: [],
      env: 'production',
      checks: checkIds.map((c) => ({ id: c, kind: 'http', config: { url: 'x' }, intervalS: 60, timeoutMs: 5000, vantage: ['core'] })),
    })
    await syncTargets(t.db, [mk('a', ['a:0:http', 'a:1:tcp']), mk('b', ['b:0:http'])])
    expect((await t.pool.query('SELECT count(*)::int AS n FROM checks')).rows[0].n).toBe(3)

    await syncTargets(t.db, [mk('a', ['a:0:http'])])
    expect((await t.pool.query('SELECT id FROM checks ORDER BY id')).rows.map((r) => r.id)).toEqual(['a:0:http'])
    expect((await t.pool.query('SELECT id FROM targets')).rows.map((r) => r.id)).toEqual(['a'])
  })

  it('allows only one open incident per check', async () => {
    const at = new Date('2026-10-29T10:00:00Z')
    expect(await openIncident(t.db, { checkId: 'c1', openedAt: at, cause: 'boom' })).toBeTypeOf('number')
    expect(await openIncident(t.db, { checkId: 'c1', openedAt: at, cause: 'again' })).toBeNull()
    expect(await hasOpenIncident(t.db, 'c1')).toBe(true)

    expect(await closeIncident(t.db, 'c1', new Date('2026-10-29T10:05:00Z'))).toBeTypeOf('number')
    expect(await closeIncident(t.db, 'c1', new Date())).toBeNull()
    expect(await hasOpenIncident(t.db, 'c1')).toBe(false)

    // a later outage can open a fresh one
    expect(await openIncident(t.db, { checkId: 'c1', openedAt: at })).toBeTypeOf('number')
  })

  it('ensures partitions idempotently and drops only fully-expired months', async () => {
    const names = await ensurePartitions(t.db, NOW, 2)
    expect(names).toEqual(['check_results_2026_10', 'check_results_2026_11', 'check_results_2026_12'])
    await ensurePartitions(t.db, NOW, 2)

    await t.db.execute(sql.raw("CREATE TABLE check_results_2026_07 PARTITION OF check_results FOR VALUES FROM ('2026-07-01Z') TO ('2026-08-01Z')"))
    await t.db.execute(sql.raw("CREATE TABLE check_results_2026_09 PARTITION OF check_results FOR VALUES FROM ('2026-09-01Z') TO ('2026-10-01Z')"))

    // cutoff = Oct 15: July (ended Aug 1) and September (ended Oct 1) are older; October is current
    const dropped = await dropOldPartitions(t.db, NOW, 14)
    expect(dropped.sort()).toEqual(['check_results_2026_07', 'check_results_2026_09'])

    const left = (await t.pool.query("SELECT relname FROM pg_class WHERE relname LIKE 'check_results\\_%' AND relkind = 'r' ORDER BY 1")).rows.map((r) => r.relname)
    expect(left).toEqual(['check_results_2026_10', 'check_results_2026_11', 'check_results_2026_12', 'check_results_default'])
  })

  it('routes inserts to partitions and falls back to default outside them', async () => {
    await insertResult(t.db, { checkId: 'p', vantage: 'core', ts: new Date('2026-10-29T01:00:00Z'), status: 'up', latencyMs: 10 })
    await insertResult(t.db, { checkId: 'p', vantage: 'core', ts: new Date('2030-01-01T00:00:00Z'), status: 'up', latencyMs: 10 })
    const r = await t.pool.query("SELECT tableoid::regclass::text AS part FROM check_results WHERE check_id = 'p' ORDER BY ts")
    expect(r.rows.map((x) => x.part)).toEqual(['check_results_2026_10', 'check_results_default'])
  })

  it('hourly rollup matches the raw aggregates and is idempotent', async () => {
    const hour = new Date('2026-10-29T09:00:00Z')
    const rows = [
      { s: 'up', l: 100 },
      { s: 'up', l: 200 },
      { s: 'degraded', l: 400 },
      { s: 'down', l: null },
      { s: 'up', l: 300 },
    ] as const
    for (const [i, r] of rows.entries()) {
      await insertResult(t.db, {
        checkId: 'r1',
        vantage: 'core',
        ts: new Date(hour.getTime() + i * 60_000),
        status: r.s,
        latencyMs: r.l,
      })
    }
    // outside the hour: must not be counted
    await insertResult(t.db, { checkId: 'r1', vantage: 'core', ts: new Date('2026-10-29T10:00:00Z'), status: 'down' })
    await insertResult(t.db, { checkId: 'r1', vantage: 'core', ts: new Date('2026-10-29T08:59:59Z'), status: 'down' })

    await rollupHour(t.db, new Date('2026-10-29T09:17:00Z')) // any instant in the hour
    await rollupHour(t.db, hour)

    const out = (await t.pool.query("SELECT * FROM results_hourly WHERE check_id = 'r1'")).rows
    expect(out).toHaveLength(1)
    // latencies sorted: 100 200 300 400 -> nearest rank p50 = 200, p95 = 400
    expect(out[0]).toMatchObject({ n: 5, p50: 200, p95: 400 })
    expect(out[0].up_ratio).toBeCloseTo(4 / 5)
    expect(out[0].hour.toISOString()).toBe(hour.toISOString())
  })

  it('users: create, case-insensitive lookup, token lookup, TOTP step claimed once', async () => {
    const u = await createUser(t.db, { email: 'Admin@Example.com', passwordHash: 'h', totpSecret: 's', role: 'ADMIN' })
    expect((await findUserByEmail(t.db, 'admin@example.COM'))?.id).toBe(u.id)
    await expect(createUser(t.db, { email: 'admin@example.com', passwordHash: 'h', totpSecret: 's', role: 'USER' })).rejects.toThrow()

    await updateUser(t.db, 'admin@example.com', { apiTokenHash: 'abc' })
    expect((await findUserByTokenHash(t.db, 'abc'))?.email).toBe('admin@example.com')
    expect(await findUserByTokenHash(t.db, 'nope')).toBeNull()

    expect(await claimTotpStep(t.db, u.id, 100)).toBe(true)
    expect(await claimTotpStep(t.db, u.id, 100)).toBe(false) // replay
    expect(await claimTotpStep(t.db, u.id, 99)).toBe(false) // older
    expect(await claimTotpStep(t.db, u.id, 101)).toBe(true)
  })
})
