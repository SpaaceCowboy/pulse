CREATE TYPE audience AS ENUM ('roco', 'admin');
CREATE TYPE role AS ENUM ('ADMIN', 'USER');
CREATE TYPE check_status AS ENUM ('up', 'degraded', 'down');

CREATE TABLE targets (
  id text PRIMARY KEY,
  name text NOT NULL,
  "group" text NOT NULL,
  audience audience NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  env text NOT NULL DEFAULT 'production'
);

CREATE TABLE checks (
  id text PRIMARY KEY,
  target_id text NOT NULL REFERENCES targets (id) ON DELETE CASCADE,
  kind text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  interval_s integer NOT NULL,
  timeout_ms integer NOT NULL,
  vantage text[] NOT NULL DEFAULT '{}'
);

-- Raw results, partitioned by month so retention is DROP TABLE, not DELETE.
-- Monthly partitions are named check_results_YYYY_MM; the worker keeps the next ones created.
CREATE TABLE check_results (
  check_id text NOT NULL,
  vantage text NOT NULL,
  ts timestamptz NOT NULL,
  status check_status NOT NULL,
  latency_ms integer,
  message text
) PARTITION BY RANGE (ts);

CREATE INDEX check_results_check_ts_idx ON check_results (check_id, ts DESC);

-- catches rows outside every monthly partition so an insert never fails on a missed rollover
CREATE TABLE check_results_default PARTITION OF check_results DEFAULT;

DO $$
DECLARE
  m date;
BEGIN
  FOR m IN SELECT generate_series(
    date_trunc('month', now() AT TIME ZONE 'UTC')::date,
    (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')::date,
    interval '1 month'
  )::date LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF check_results FOR VALUES FROM (%L) TO (%L)',
      'check_results_' || to_char(m, 'YYYY_MM'),
      (m::timestamp AT TIME ZONE 'UTC'),
      ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC')
    );
  END LOOP;
END $$;

CREATE TABLE results_hourly (
  check_id text NOT NULL,
  hour timestamptz NOT NULL,
  up_ratio double precision NOT NULL,
  p50 integer,
  p95 integer,
  n integer NOT NULL,
  PRIMARY KEY (check_id, hour)
);

CREATE TABLE incidents (
  id bigserial PRIMARY KEY,
  check_id text NOT NULL,
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz,
  cause text,
  last_message text
);

-- at most one open incident per check, enforced by the database
CREATE UNIQUE INDEX incidents_one_open_per_check ON incidents (check_id) WHERE resolved_at IS NULL;
CREATE INDEX incidents_opened_at_idx ON incidents (opened_at DESC);

CREATE TABLE heartbeats (
  token text PRIMARY KEY,
  check_id text NOT NULL,
  last_ping_at timestamptz,
  grace_s integer NOT NULL
);

CREATE TABLE host_metrics (
  host text NOT NULL,
  ts timestamptz NOT NULL,
  cpu double precision,
  mem double precision,
  disk jsonb,
  units jsonb,
  containers jsonb,
  PRIMARY KEY (host, ts)
);

CREATE TABLE error_events (
  source text NOT NULL,
  external_id text NOT NULL,
  target_id text NOT NULL,
  title text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  last_seen timestamptz NOT NULL,
  PRIMARY KEY (source, external_id)
);

CREATE TABLE users (
  id bigserial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  totp_secret text,
  role role NOT NULL,
  telegram_chat_id text
);
