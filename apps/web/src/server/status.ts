// THE data-access boundary for the web app. Every function takes the viewer first, and nothing else in
// apps/web may touch targets, checks, results, incidents or Redis state (enforced by boundary.test.ts).
//
// Scoping is applied twice on purpose: in SQL (`audience = ANY(visibleAudiences(viewer))`, so rows the
// viewer may not see are never fetched, and Redis is only read for check ids of visible targets) and
// again in JS with scopeTargets(viewer, ...) as a belt-and-braces filter.
import 'server-only'
import { sql } from '@pulse/db'
import { scopeTargets, visibleAudiences, type Viewer } from '@pulse/core'
import { sortTargets } from '@/lib/diff'
import type {
  CheckView,
  IncidentView,
  ResultView,
  Snapshot,
  Status,
  Summary,
  TargetDetail,
  TargetView,
} from '@/lib/types'
import { getDb, getRedis } from './runtime'

const STATE_PREFIX = 'pulse:state:'
const DAYS = 90
const DAY_MS = 86_400_000

interface StoredState {
  state: { phase: 'up' | 'suspect' | 'down' | 'recovering'; changedAt: number }
  last: { status: 'up' | 'degraded' | 'down'; ts: number; latencyMs?: number; message?: string; daysLeft?: number }
}

type TargetRow = {
  id: string
  name: string
  group: string
  audience: 'roco' | 'admin'
  tags: string[]
}
type CheckRow = {
  id: string
  target_id: string
  kind: string
}

/** `ARRAY['a','b']::text[]`; drizzle would expand a bare JS array into a comma list, not an array parameter. */
const textArray = (values: string[]) => sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`

const PASSIVE_KINDS = new Set(['heartbeat', 'agent', 'queue'])

async function visibleTargets(viewer: Viewer, onlyId?: string): Promise<TargetRow[]> {
  const audiences = visibleAudiences(viewer)
  if (audiences.length === 0) return []
  const res = await getDb().execute<TargetRow>(sql`
    SELECT id, name, "group", audience, tags FROM targets
    WHERE audience::text = ANY(${textArray(audiences)})
      ${onlyId ? sql`AND id = ${onlyId}` : sql``}
    ORDER BY name`)
  return scopeTargets(viewer, res.rows)
}

function checkStatus(s: StoredState | null, kind: string): Status {
  if (!s) return 'unknown'
  if (PASSIVE_KINDS.has(kind)) return 'unknown'
  if (s.state.phase === 'down' || s.state.phase === 'recovering') return 'down'
  if (s.state.phase === 'suspect') return 'degraded'
  return s.last.status === 'down' ? 'degraded' : s.last.status
}

const SEVERITY: Record<Status, number> = { down: 3, degraded: 2, up: 1, unknown: 0 }

function worst(statuses: Status[]): Status {
  return statuses.reduce<Status>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'unknown')
}

async function loadViews(viewer: Viewer, onlyId?: string): Promise<{ views: TargetView[]; openIncidents: number }> {
  const trows = await visibleTargets(viewer, onlyId)
  if (trows.length === 0) return { views: [], openIncidents: 0 }
  const db = getDb()
  const ids = trows.map((t) => t.id)

  const crows = (
    await db.execute<CheckRow>(sql`SELECT id, target_id, kind FROM checks WHERE target_id = ANY(${textArray(ids)}) ORDER BY id`)
  ).rows
  const checkIds = crows.map((c) => c.id)

  const stateRaw = checkIds.length ? await getRedis().mget(checkIds.map((id) => STATE_PREFIX + id)) : []
  const states = new Map<string, StoredState | null>(
    checkIds.map((id, i) => [id, stateRaw[i] ? (JSON.parse(stateRaw[i]!) as StoredState) : null]),
  )

  const open = (
    await db.execute<{ target_id: string }>(sql`
      SELECT c.target_id FROM incidents i JOIN checks c ON c.id = i.check_id
      WHERE i.resolved_at IS NULL AND c.target_id = ANY(${textArray(ids)})`)
  ).rows.length

  const p95 = new Map(
    (
      await db.execute<{ target_id: string; p95: number }>(sql`
        SELECT c.target_id, percentile_disc(0.95) WITHIN GROUP (ORDER BY r.latency_ms)::int AS p95
        FROM check_results r JOIN checks c ON c.id = r.check_id
        WHERE c.target_id = ANY(${textArray(ids)}) AND c.kind IN ('http', 'json')
          AND r.latency_ms IS NOT NULL AND r.ts > now() - interval '24 hours'
        GROUP BY c.target_id`)
    ).rows.map((r) => [r.target_id, r.p95]),
  )

  const dayRows = (
    await db.execute<{ target_id: string; day: string; ratio: number }>(sql`
      SELECT c.target_id, to_char(h.hour AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             (sum(h.up_ratio * h.n) / sum(h.n))::float8 AS ratio
      FROM results_hourly h JOIN checks c ON c.id = h.check_id
      WHERE c.target_id = ANY(${textArray(ids)}) AND c.kind NOT IN ('tls', 'domain')
        AND h.hour > now() - interval '91 days'
      GROUP BY 1, 2`)
  ).rows
  const dayMap = new Map(dayRows.map((r) => [`${r.target_id}|${r.day}`, r.ratio]))
  const todayUtc = Math.floor(Date.now() / DAY_MS) * DAY_MS

  const views = trows.map<TargetView>((t) => {
    const checks = crows
      .filter((c) => c.target_id === t.id)
      .map<CheckView>((c) => {
        const s = states.get(c.id) ?? null
        return {
          id: c.id,
          kind: c.kind,
          status: checkStatus(s, c.kind),
          message: s?.last.message ?? null,
          latencyMs: s?.last.latencyMs ?? null,
          ts: s?.last.ts ?? null,
          since: s && s.state.changedAt > 0 ? s.state.changedAt : null,
          daysLeft: s?.last.daysLeft ?? null,
        }
      })
    const bad = checks
      .filter((c) => c.status === 'down' || c.status === 'degraded')
      .sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status])[0]
    const days = Array.from({ length: DAYS }, (_, i) => {
      const day = new Date(todayUtc - (DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10)
      return dayMap.get(`${t.id}|${day}`) ?? null
    })
    return {
      id: t.id,
      name: t.name,
      group: t.group,
      audience: t.audience,
      tags: t.tags,
      status: worst(checks.map((c) => c.status)),
      p95Ms: p95.get(t.id) ?? null,
      tlsDaysLeft: checks.find((c) => c.kind === 'tls')?.daysLeft ?? null,
      domainDaysLeft: checks.find((c) => c.kind === 'domain')?.daysLeft ?? null,
      errorCount: 0,
      problem: bad ? { checkId: bad.id, kind: bad.kind, message: bad.message, since: bad.since } : null,
      days,
      checks,
    }
  })
  return { views: scopeTargets(viewer, views), openIncidents: open }
}

export function summarize(views: TargetView[], openIncidents: number): Summary {
  const s: Summary = { up: 0, degraded: 0, down: 0, unknown: 0, openIncidents }
  for (const v of views) s[v.status]++
  return s
}

/** Everything the dashboard and status.json show, for exactly the targets this viewer may see. */
export async function getSnapshot(viewer: Viewer): Promise<Snapshot> {
  const { views, openIncidents } = await loadViews(viewer)
  return { generatedAt: Date.now(), summary: summarize(views, openIncidents), targets: sortTargets(views) }
}

/** null for both "does not exist" and "not visible to you", so existence of admin targets never leaks. */
export async function getTargetDetail(viewer: Viewer, targetId: string): Promise<TargetDetail | null> {
  const { views } = await loadViews(viewer, targetId)
  const target = views[0]
  if (!target) return null
  const db = getDb()
  const checkIds = target.checks.map((c) => c.id)

  const sparklines: TargetDetail['sparklines'] = {}
  if (checkIds.length) {
    const rows = (
      await db.execute<{ check_id: string; vantage: string; b: Date; ms: number }>(sql`
        SELECT check_id, vantage, date_bin('15 minutes', ts, TIMESTAMPTZ '2000-01-01') AS b, avg(latency_ms)::int AS ms
        FROM check_results
        WHERE check_id = ANY(${textArray(checkIds)}) AND ts > now() - interval '24 hours' AND latency_ms IS NOT NULL
        GROUP BY 1, 2, 3 ORDER BY b`)
    ).rows
    for (const r of rows) {
      ;((sparklines[r.check_id] ??= {})[r.vantage] ??= []).push([new Date(r.b).getTime(), r.ms])
    }
  }

  const results: TargetDetail['results'] = {}
  for (const id of checkIds) {
    const rows = (
      await db.execute<{ vantage: string; ts: Date; status: ResultView['status']; latency_ms: number | null; message: string | null }>(sql`
        SELECT vantage, ts, status, latency_ms, message FROM check_results
        WHERE check_id = ${id} ORDER BY ts DESC LIMIT 10`)
    ).rows
    results[id] = rows.map((r) => ({
      vantage: r.vantage,
      ts: new Date(r.ts).getTime(),
      status: r.status,
      latencyMs: r.latency_ms,
      message: r.message,
    }))
  }

  return { target, sparklines, results, incidents: await queryIncidents(viewer, 20, targetId) }
}

async function queryIncidents(viewer: Viewer, limit: number, targetId?: string): Promise<IncidentView[]> {
  const audiences = visibleAudiences(viewer)
  if (audiences.length === 0) return []
  const rows = (
    await getDb().execute<{
      id: string
      target_id: string
      name: string
      audience: 'roco' | 'admin'
      kind: string
      opened_at: Date
      resolved_at: Date | null
      cause: string | null
      last_message: string | null
    }>(sql`
      SELECT i.id, t.id AS target_id, t.name, t.audience, c.kind, i.opened_at, i.resolved_at, i.cause, i.last_message
      FROM incidents i JOIN checks c ON c.id = i.check_id JOIN targets t ON t.id = c.target_id
      WHERE t.audience::text = ANY(${textArray(audiences)}) ${targetId ? sql`AND t.id = ${targetId}` : sql``}
      ORDER BY i.opened_at DESC LIMIT ${limit}`)
  ).rows
  return scopeTargets(viewer, rows).map((r) => ({
    id: Number(r.id),
    targetId: r.target_id,
    targetName: r.name,
    checkKind: r.kind,
    openedAt: new Date(r.opened_at).getTime(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).getTime() : null,
    cause: r.cause,
    lastMessage: r.last_message,
  }))
}

export async function listIncidents(viewer: Viewer, limit = 100): Promise<IncidentView[]> {
  return queryIncidents(viewer, Math.min(Math.max(limit, 1), 500))
}
