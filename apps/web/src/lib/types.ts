// Wire shapes shared by server (server/status.ts) and client components. No server imports here.

export type Status = 'up' | 'degraded' | 'down' | 'unknown'

export interface CheckView {
  id: string
  kind: string
  status: Status
  message: string | null
  latencyMs: number | null
  /** epoch ms of the last result, null if the check has not run yet */
  ts: number | null
  /** epoch ms of the last phase change */
  since: number | null
  daysLeft: number | null
}

export interface TargetView {
  id: string
  name: string
  group: string
  audience: 'roco' | 'admin'
  tags: string[]
  status: Status
  p95Ms: number | null
  tlsDaysLeft: number | null
  domainDaysLeft: number | null
  /** error_events count; filled from Phase 5 */
  errorCount: number
  /** worst failing check, for the problems strip */
  problem: { checkId: string; kind: string; message: string | null; since: number | null } | null
  /** 90 UTC days, oldest first; uptime ratio 0..1 or null where there is no data */
  days: Array<number | null>
  checks: CheckView[]
}

export interface Summary {
  up: number
  degraded: number
  down: number
  unknown: number
  openIncidents: number
}

export interface Snapshot {
  generatedAt: number
  summary: Summary
  targets: TargetView[]
}

export interface ResultView {
  vantage: string
  ts: number
  status: Exclude<Status, 'unknown'>
  latencyMs: number | null
  message: string | null
}

export interface IncidentView {
  id: number
  targetId: string
  targetName: string
  checkKind: string
  openedAt: number
  resolvedAt: number | null
  cause: string | null
  lastMessage: string | null
}

export interface TargetDetail {
  target: TargetView
  /** per check id, then per vantage: [epoch ms, avg latency ms] in 15-minute bins over 24 h */
  sparklines: Record<string, Record<string, Array<[number, number]>>>
  /** last 10 raw results per check id */
  results: Record<string, ResultView[]>
  incidents: IncidentView[]
}

export interface StreamDiff {
  generatedAt: number
  summary: Summary
  upserts: TargetView[]
  removed: string[]
}
