# Phase 2 notes — Storage, state machine, incidents

## Built
- `packages/core/src/state/machine.ts`: pure `reduce(state, observation)` returning `{ state, events }` (`up → suspect → down → recovering → up`, 3 fails opens, 2 passes closes). `degraded` is a pass for the incident path and is tracked on its own track (`degradedSince`, `degradedSustained` after > 15 min, with `degraded_sustained` / `degraded_cleared` events). `aggregateVantages` collapses a round of per-vantage results (majority down = down, minority down = `degraded` "regional: ..."). No I/O; 19 unit tests.
- `packages/db/migrations/0001_init/{up,down}.sql`: all tables; `check_results` is range-partitioned by month (`check_results_YYYY_MM` plus a default partition); `(check_id, ts desc)` index; partial unique index `incidents_one_open_per_check`. `packages/db/src/migrate.ts` is a small runner (`_pulse_migrations` table, advisory lock, one transaction per migration, refuses a migration without a down). CLI: `pnpm migrate up|down [n]|status`. drizzle-kit was not used because it cannot produce down migrations or partitioned tables; `schema.ts` stays as the typed query layer and a test fails on column drift.
- `packages/db/src/store.ts`: `syncTargets`, `insertResult`, `openIncident` / `closeIncident` / `hasOpenIncident`, `ensurePartitions`, `dropOldPartitions`, `rollupHour` / `rollupRecent`.
- `apps/worker`: `state-store.ts` (Redis `pulse:state:<checkId>` = state + last result), `record.ts` (`recordResult`: raw row → aggregate → reduce → open/close incident → save state), `maintenance.ts` (queue `pulse-maintenance`: hourly rollup of the last 3 hours, daily partition create/drop; also run at boot). `index.ts` now runs `migrateUp`, syncs `targets.yaml` into Postgres, then starts the scheduler with `onResult → recordResult`.
- Test harness: `docker-compose.dev.yml` publishes Postgres (127.0.0.1:5433) and Redis (127.0.0.1:6380); `pnpm test:db` points the suite at them (`scripts/test-db.mjs`, creds from `.env`), one throwaway database per test file. Plain `pnpm test` skips the DB tests and needs no Docker.

## Verification
- `pnpm typecheck` clean. `pnpm test`: 94 passed, 12 DB/Redis tests skipped. `pnpm test:db`: 106 passed.
- PLAN check "fail-fail-fail-pass-pass → exactly one incident opened and closed": `apps/worker/src/record.test.ts` runs it through `recordResult` on real Postgres + Redis (opened at the 3rd result, resolved at the 5th). Also covered: degraded never opens, state survives a fresh store instance, Redis key lost while an incident is open (no duplicate, recovery still resolves it), two outages give two incidents.
- PLAN check "rollup matches raw aggregates": `db.test.ts` seeds known rows (including rows just outside the hour) and asserts n, p50, p95, up_ratio, and that re-running is idempotent.
- Migrations up → down → up: in `db.test.ts` (asserts no tables or enum types remain after down and that the re-applied schema equals the first) and by hand with the CLI against the compose database.
- Live: rebuilt the worker; it applied the migration, synced 8 targets / 16 checks, wrote raw rows and `pulse:state:*` keys for all 16 checks, and opened its first real incident (below).

## Decisions taken (as agreed)
- Degraded never opens an incident in this phase; `degradedSustained` is only a flag in the stored state for Phase 4 to alert on.
- `up_ratio = (up + degraded) / n`; percentiles are nearest-rank over non-null latencies.
- Only the `core` vantage exists; the aggregation is wired but trivial until Phase 4.

## Known limits / carry-overs
- **Live incident on termspace.** `targets.yaml` no longer has any `.example` hosts (they were replaced by the `termspace.13.140.89.146.sslip.io` URLs), so `isPlaceholder` now matches nothing and termspace is stored like any other target. Those URLs time out from the worker, and `termspace:1:http` opened incident #1 after 3 failures. That is correct behaviour for the data given; fix or remove those checks once the host is decided. The local compose database now holds this real incident.
- Retention is by month partition: a partition is dropped once its whole month is older than 14 days, so raw rows live between 14 and about 45 days.
- Check ids are positional (`target:index:kind`); reordering checks in `targets.yaml` re-keys their history.
- `last_message` of an incident is set when it opens and is not refreshed while it stays open.
- Inserting a result outside every monthly partition falls into `check_results_default`; creating a partition for a range that already has rows in default would fail. The daily job keeps two months ahead, so this only matters if the worker is down across a month boundary.
- Domain checks still return `degraded` here (unchanged from Phase 1), so they produce no incidents.
- Vault update skipped: local dev stack only, nothing deployed.
