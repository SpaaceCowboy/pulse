# Phase 0 notes — Scaffold & inventory

## Built
- pnpm monorepo (pnpm 10.34.9, Node 22 in images): `apps/web` (Next 15, Tailwind 4, placeholder page + `/api/healthz`), `apps/worker` (loads `targets.yaml`, pings Postgres/Redis, `/healthz`; no checkers yet), `packages/core` (`Checker`/`CheckResult` types, Zod schema + YAML loader for targets), `packages/db` (Drizzle table definitions only; no migrations).
- `docker-compose.yml`: postgres:16, redis:7, worker, web, caddy — all with healthchecks, `depends_on: service_healthy`, named volumes. `Caddyfile` adds `X-Robots-Tag: noindex`.
- `.env.example`, `.dockerignore`, `CLAUDE.md`, `targets.yaml` (8 targets: 6 roco, 2 admin).

## Verification (PLAN.md Phase 0)
- `docker compose up -d --build`: all 5 services healthy; `curl localhost:8080/` returns the Pulse page via Caddy.
- `pnpm typecheck`: clean (4 packages).
- `pnpm test`: 6/6. A target without `audience` is rejected; unknown audience, unknown check kind and duplicate ids are rejected too.
- `pnpm validate:targets`: ok, 8 targets.

## Decisions / deviations
- `CLAUDE.md` did not exist; I wrote a short one. Removed the duplicate root `PLAN.md`.
- Local `.env` (gitignored) uses ports 8080/8443 and a throwaway DB password.
- No `down` migrations yet; Drizzle migrations and `check_results` partitioning are Phase 2.
- shadcn/ui not initialised (Phase 3).
- Worker runs via `tsx` in the container (simple for now; consider a compiled build later).

## Local environment gotchas
- Corepack's `pnpm` shim on this machine is broken (missing pnpm 12.16.1). I used the npm-global pnpm 10 (`%APPDATA%\npm`) by putting it first on PATH.
- `next build` run directly on Windows fails with `EPERM: symlink` at the standalone step (needs Developer Mode/admin). Builds fine in Docker.
- Docker Desktop must be running.

## Carry-overs to Phase 1
- Placeholder/unconfirmed values in `targets.yaml`: termspace URLs (`termspace.example`, host not decided), cPanel host (`cpanel.example`), mail host (`mail.rocobroker.com`), roco-seo `/health` URL, Ubuntu shared VPS IP, client-portal login keyword (`login`). Confirm before Phase 1.
- Check `config` is a free-form record; per-kind schemas go in with each checker.
- `ALERTS_ENABLED`, Telegram, SMTP, HMAC and watchdog vars exist in `.env.example` but are unused.
- Vault update skipped: nothing deployed.
