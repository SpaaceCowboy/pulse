// Table shapes from docs/PLAN.md "Data model". Migrations, monthly partitioning of
// check_results and rollup jobs arrive in Phase 2.
import {
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

export const audienceEnum = pgEnum('audience', ['roco', 'admin'])
export const roleEnum = pgEnum('role', ['ADMIN', 'USER'])
export const statusEnum = pgEnum('check_status', ['up', 'degraded', 'down'])

export const targets = pgTable('targets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  group: text('group').notNull(),
  audience: audienceEnum('audience').notNull(),
  tags: text('tags').array().notNull().default([]),
  env: text('env').notNull().default('production'),
})

export const checks = pgTable('checks', {
  id: text('id').primaryKey(),
  targetId: text('target_id')
    .notNull()
    .references(() => targets.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  config: jsonb('config').notNull().default({}),
  intervalS: integer('interval_s').notNull(),
  timeoutMs: integer('timeout_ms').notNull(),
  vantage: text('vantage').array().notNull().default([]),
})

export const checkResults = pgTable(
  'check_results',
  {
    checkId: text('check_id').notNull(),
    vantage: text('vantage').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    status: statusEnum('status').notNull(),
    latencyMs: integer('latency_ms'),
    message: text('message'),
  },
  (t) => [index('check_results_check_ts_idx').on(t.checkId, t.ts.desc())],
)

export const resultsHourly = pgTable(
  'results_hourly',
  {
    checkId: text('check_id').notNull(),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    upRatio: doublePrecision('up_ratio').notNull(),
    p50: integer('p50'),
    p95: integer('p95'),
    n: integer('n').notNull(),
  },
  (t) => [primaryKey({ columns: [t.checkId, t.hour] })],
)

export const incidents = pgTable('incidents', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  checkId: text('check_id').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  cause: text('cause'),
  lastMessage: text('last_message'),
})

export const heartbeats = pgTable('heartbeats', {
  token: text('token').primaryKey(),
  checkId: text('check_id').notNull(),
  lastPingAt: timestamp('last_ping_at', { withTimezone: true }),
  graceS: integer('grace_s').notNull(),
})

export const hostMetrics = pgTable(
  'host_metrics',
  {
    host: text('host').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    cpu: doublePrecision('cpu'),
    mem: doublePrecision('mem'),
    disk: jsonb('disk'),
    units: jsonb('units'),
    containers: jsonb('containers'),
  },
  (t) => [primaryKey({ columns: [t.host, t.ts] })],
)

export const errorEvents = pgTable(
  'error_events',
  {
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    targetId: text('target_id').notNull(),
    title: text('title').notNull(),
    count: integer('count').notNull().default(1),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.externalId] })],
)

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  role: roleEnum('role').notNull(),
  telegramChatId: text('telegram_chat_id'),
})
