# Pulse

Self-hosted health-check dashboard. Full spec: `docs/PLAN.md` (source of truth). Work one phase at a time; each ends with `PHASE_<N>_NOTES.md` and a commit `phase <N>: <summary>`.

## Layout
- `apps/web` — Next.js (App Router, standalone): status page, ingest/agent endpoints
- `apps/worker` — scheduler + checkers + alerting
- `packages/core` — shared types, checkers, `targets.yaml` Zod schema
- `packages/db` — Drizzle schema/client
- `targets.yaml` — target registry (source of truth, in git, no secrets)

## Commands
- `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm validate:targets`
- `pnpm test:db` — also runs Postgres/Redis integration tests (needs `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis`)
- `pnpm migrate up|down [n]|status` (needs `DATABASE_URL`); every migration in `packages/db/migrations/NNNN_name/` needs `up.sql` and `down.sql`
- `docker compose up -d --build` (copy `.env.example` to `.env` first)

## Rules
- Every target in `targets.yaml` must have `audience: roco | admin`; USER role must never receive admin targets (enforced by `scopeTargets(user)` from Phase 3).
- Secrets only in `.env` on the server; never in `targets.yaml` or the repo.
- Checker outbound: UA `PulseMonitor/1.0`, timeout <= 10 s, concurrency <= 10.
- Never edit nginx/Xray configs from this project; the agent only reads.
- Only do the current phase's scope.
