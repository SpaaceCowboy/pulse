// Phase 2 storage: target sync, raw results, incidents, month partitions, hourly rollup.
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm'
import type { createDb } from './client'
import { checkResults, checks, incidents, targets } from './schema'

export type Db = ReturnType<typeof createDb>['db']
type Status = 'up' | 'degraded' | 'down'

// ---- target / check sync (targets.yaml is the source of truth) ----

export interface SyncCheck {
  id: string
  kind: string
  config: unknown
  intervalS: number
  timeoutMs: number
  vantage: string[]
}
export interface SyncTarget {
  id: string
  name: string
  group: string
  audience: 'roco' | 'admin'
  tags: string[]
  env: string
  checks: SyncCheck[]
}

/** Mirror the registry into Postgres; rows no longer in the registry are removed. */
export async function syncTargets(db: Db, list: SyncTarget[]): Promise<void> {
  await db.transaction(async (tx) => {
    const targetIds = list.map((t) => t.id)
    if (targetIds.length === 0) {
      await tx.delete(targets)
      return
    }
    await tx.delete(targets).where(notInArray(targets.id, targetIds)) // cascades to checks
    for (const t of list) {
      const { checks: _checks, ...row } = t
      await tx
        .insert(targets)
        .values(row)
        .onConflictDoUpdate({ target: targets.id, set: row })
      const ids = t.checks.map((c) => c.id)
      await tx
        .delete(checks)
        .where(ids.length ? and(eq(checks.targetId, t.id), notInArray(checks.id, ids)) : eq(checks.targetId, t.id))
      for (const c of t.checks) {
        const row = { ...c, config: c.config ?? {}, targetId: t.id }
        await tx.insert(checks).values(row).onConflictDoUpdate({ target: checks.id, set: row })
      }
    }
  })
}

// ---- raw results ----

export interface ResultRow {
  checkId: string
  vantage: string
  ts: Date
  status: Status
  latencyMs?: number | null
  message?: string | null
}

export async function insertResult(db: Db, r: ResultRow): Promise<void> {
  await db.insert(checkResults).values({
    checkId: r.checkId,
    vantage: r.vantage,
    ts: r.ts,
    status: r.status,
    latencyMs: r.latencyMs == null ? null : Math.round(r.latencyMs),
    message: r.message ?? null,
  })
}

// ---- incidents ----

/** Opens an incident unless one is already open (the partial unique index guarantees one). */
export async function openIncident(
  db: Db,
  p: { checkId: string; openedAt: Date; cause?: string | null; lastMessage?: string | null },
): Promise<number | null> {
  const rows = await db
    .insert(incidents)
    .values({
      checkId: p.checkId,
      openedAt: p.openedAt,
      cause: p.cause ?? null,
      lastMessage: p.lastMessage ?? p.cause ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: incidents.id })
  return rows[0]?.id ?? null
}

/** Resolves the open incident for a check, if any. Returns its id. */
export async function closeIncident(db: Db, checkId: string, resolvedAt: Date): Promise<number | null> {
  const rows = await db
    .update(incidents)
    .set({ resolvedAt })
    .where(and(eq(incidents.checkId, checkId), isNull(incidents.resolvedAt)))
    .returning({ id: incidents.id })
  return rows[0]?.id ?? null
}

export async function hasOpenIncident(db: Db, checkId: string): Promise<boolean> {
  const rows = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(and(eq(incidents.checkId, checkId), isNull(incidents.resolvedAt)))
    .limit(1)
  return rows.length > 0
}

// ---- month partitions of check_results ----

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
const partName = (d: Date) =>
  `check_results_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`

/** Creates the partitions for this month and the next `monthsAhead`. Idempotent. */
export async function ensurePartitions(db: Db, now: Date, monthsAhead = 2): Promise<string[]> {
  const names: string[] = []
  for (let i = 0; i <= monthsAhead; i++) {
    const from = addMonths(monthStart(now), i)
    const to = addMonths(from, 1)
    const name = partName(from)
    await db.execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF check_results ` +
          `FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`,
      ),
    )
    names.push(name)
  }
  return names
}

/**
 * Drops monthly partitions whose whole range ended more than `retentionDays` ago.
 * Granularity is a month, so rows live between 14 and ~45 days. The default partition is never dropped.
 */
export async function dropOldPartitions(db: Db, now: Date, retentionDays = 14): Promise<string[]> {
  const res = await db.execute<{ relname: string }>(
    sql`SELECT c.relname FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'check_results' AND c.relname ~ '^check_results_[0-9]{4}_[0-9]{2}$'`,
  )
  const cutoff = now.getTime() - retentionDays * 86_400_000
  const dropped: string[] = []
  for (const { relname } of res.rows) {
    const [, y, m] = /_(\d{4})_(\d{2})$/.exec(relname)!
    const upper = Date.UTC(Number(y), Number(m), 1) // exclusive end of that month
    if (upper <= cutoff) {
      await db.execute(sql.raw(`DROP TABLE ${relname}`))
      dropped.push(relname)
    }
  }
  return dropped
}

// ---- hourly rollup ----

const hourStart = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000)

/**
 * Aggregates raw results of one UTC hour into results_hourly. Idempotent (upsert).
 * up_ratio counts `degraded` as available: only `down` counts against uptime.
 * Percentiles are nearest-rank over non-null latencies.
 */
export async function rollupHour(db: Db, hour: Date): Promise<number> {
  const from = hourStart(hour).toISOString()
  const res = await db.execute(sql`
    INSERT INTO results_hourly (check_id, hour, up_ratio, p50, p95, n)
    SELECT check_id, ${from}::timestamptz,
           avg((status <> 'down')::int)::float8,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms)::int,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int,
           count(*)::int
    FROM check_results
    WHERE ts >= ${from}::timestamptz AND ts < ${from}::timestamptz + interval '1 hour'
    GROUP BY check_id
    ON CONFLICT (check_id, hour) DO UPDATE
      SET up_ratio = EXCLUDED.up_ratio, p50 = EXCLUDED.p50, p95 = EXCLUDED.p95, n = EXCLUDED.n`)
  return res.rowCount ?? 0
}

/** Re-rolls the last `hours` hours including the current partial one (late results are safe). */
export async function rollupRecent(db: Db, now: Date, hours = 3): Promise<void> {
  const end = hourStart(now).getTime()
  for (let i = 0; i < hours; i++) await rollupHour(db, new Date(end - i * 3_600_000))
}
