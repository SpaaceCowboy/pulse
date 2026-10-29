# Phase 3 notes — Auth, roles, dashboard

## Built
- **Users + auth.** Migration `0002_users_api_token` (reversible) adds `users.api_token_hash`, `totp_last_step`, `created_at`. `packages/core/src/auth/crypto.ts`: scrypt password hashes (self-describing `scrypt$N$r$p$salt$hash`), RFC 6238 TOTP via `otpauth` (±1 step), API tokens (`pls_…`, only a SHA-256 is stored). `apps/web/src/auth.ts`: Auth.js v5 credentials provider (email + password + 6-digit code), JWT session holding only the user id, 12 h lifetime. TOTP is mandatory (no secret = no login), a used time step cannot be replayed (`claimTotpStep` is a single atomic UPDATE), unknown users cost the same as wrong passwords (dummy hash), failed logins are rate limited in Redis (5 per 15 min per email and per IP), and every failure shows the same message.
- **No sign-up.** There is no registration route or UI. Accounts exist only through `pnpm user …` (`packages/db/src/user-cli.ts`): `create <email> --role ADMIN|USER` (password prompt or `--password-stdin`, min 12 chars, prints the TOTP secret and `otpauth://` URI once), `token`, `reset-totp`, `set-role`, `passwd`, `delete`, `list`.
- **`scopeTargets(user)`** (`packages/core/src/auth/scope.ts`): ADMIN sees everything, USER only `audience = roco`; fails closed for no viewer, unknown role or unknown audience. `visibleAudiences()` feeds SQL filters. Tests run over every real target in `targets.yaml`.
- **One choke point.** `apps/web/src/server/status.ts` is the only module that reads targets, checks, results, incidents or Redis state. Every export takes the viewer first. Scoping happens in SQL (`audience = ANY(visibleAudiences)`) and again in JS with `scopeTargets`; Redis is only read for check ids of visible targets. `server/viewer.ts` resolves the viewer from the users table on every request (session id, or `Authorization: Bearer pls_…` for `status.json` only), so a deleted or demoted user loses access immediately. `middleware.ts` is a first gate (deny by default: only `/login`, `/api/auth/*`, `/api/healthz`, `/robots.txt` are public).
- **Routes:** `/` (server-rendered from the scoped snapshot), `/incidents`, `/login`, `/api/status.json`, `/api/targets/[id]`, `/api/incidents`, `/api/stream` (SSE: one `snapshot`, then `diff` events with changed targets only; the viewer is re-read every 5 s and the stream closes if the user is gone). An admin target requested by a USER returns **404**, identical to a nonexistent id.
- **Dashboard** per PLAN: banner (overall state for the viewer's targets, open incidents, live dot), problems strip, groups (Roco Broker / Personal & client projects / Infrastructure), rows with status pill, p95 (24 h), 90-day uptime bar (from `results_hourly`), TLS/domain days-left badges, expandable per-check detail (24 h sparkline per vantage, last 10 results, recent incidents), incidents page. Dark, Tailwind v4, `prefers-reduced-motion` respected, no client polling, usable at phone width.
- **Worker (small, additive):** `StoredState.last.daysLeft` is now stored so the TLS/domain badges have data.
- **Compose / Docker:** web image now copies `packages/core` and `packages/db`; `AUTH_SECRET` is required in `docker-compose.yml`.

## Verification
- `pnpm typecheck` clean. `pnpm test`: 118 passed (18 DB tests skipped). `pnpm test:db`: 136 passed.
- Scope contract: `scope.test.ts` (unit) and `apps/web/src/server/status.test.ts` (real Postgres + Redis): a USER snapshot, target detail and incident list contain no admin id, name, message or group name anywhere in the serialized JSON; detail for an admin id is `null`; missing viewer or unknown role gets nothing.
- `apps/web/src/server/boundary.test.ts` fails the build if any file outside `server/` + `auth.ts` imports the db, Redis or the targets loader, if a handler does not resolve a viewer and call `status.ts` with it, or if a `status.ts` export does not take the viewer first. (It failed on the scaffold `page.tsx` until the real page was written, which is how I know it bites.)
- **Playwright** (`pnpm test:e2e`, 10 tests, isolated stack: throwaway Postgres DB, Redis db 1, fixture servers, the real worker on `e2e/targets.e2e.yaml`, production `next start`):
  - anonymous: redirect to `/login` or 401 on every route; no sign-up route (GET/POST on common paths);
  - bad password, bad code, and an already-used/older TOTP step are all rejected;
  - **USER**: only the roco targets in the rendered page, **in the raw HTML** (including embedded RSC data), in `status.json`, in `/api/incidents`, in `/incidents`, and in 12 s of SSE events; `/api/targets/<admin id>` is 404; bearer token is scoped the same and works on `status.json` only;
  - **ADMIN**: sees all groups and the admin target; row expands;
  - **kill test:** stopping the roco and admin fixtures turned both rows red via SSE with no reload (about 19 s with 5 s fixture intervals; PLAN allows 3 min); the USER sees the roco outage in the banner and incidents, nothing about the admin one.
- **Lighthouse mobile** (`pnpm lighthouse`, default mobile emulation and throttling, logged-in): login 100 / 100 / 96, dashboard 99 / 100 / 100, incidents 99 / 100 / 100 (performance / accessibility / best practices).
- Live: rebuilt the compose `web`; through Caddy (`:8080`) `/` redirects to `/login`, `status.json`, `stream`, `incidents` return 401, `robots.txt` and `healthz` are public, `X-Robots-Tag: noindex, nofollow` is set.
- Migration `0002` up → down → up is covered by the existing generic migration test plus the column-drift test.

## Deviations from the agreed plan
- **SSE** uses a per-connection loop (each connection calls `getSnapshot(viewer)` every 5 s) instead of one shared poller. At two users it costs nothing, and every event is built from that viewer's own scoped query, which is easier to reason about. Worker pub/sub can replace the tick in Phase 4.
- **shadcn/ui:** I did not run the shadcn CLI or add Radix. The few primitives needed (pill, badge, bar, sparkline) are hand-written in the shadcn style (Tailwind tokens, `cn`, no extra dependencies). Say if you want the real library.
- **Lighthouse gate excludes the SEO category.** The app is deliberately `noindex` (PLAN: not publicly indexed), which Lighthouse scores as a failure (SEO 54). Performance, accessibility and best practices are the gate.

## Known limits / carry-overs
- No profile page; Telegram chat linking is Phase 4. TOTP provisioning is the secret + `otpauth://` URI printed by the CLI (no QR image).
- Error counts are always 0 and host metrics are absent until Phase 5 fills `error_events` and `host_metrics`.
- TLS/domain badges stay empty until each check next runs after the worker restart (every 6 h / 24 h), because older Redis states have no `daysLeft`.
- `middleware.ts` only checks for a session cookie (edge runtime, no DB); the real decision is per request in `server/viewer.ts`.
- Local Windows builds cannot create the symlinks Next's standalone trace needs, so `pnpm test:e2e` / `pnpm lighthouse` set `PULSE_NO_STANDALONE=1`. The Docker (Linux) build is unchanged. Playwright's browser CDN is geoblocked from here, so e2e uses system Chrome (`channel: 'chrome'`).
- `.env` needs `AUTH_SECRET` before `docker compose up` (it now fails fast without it). A local one was generated in the gitignored `.env`.
- The live termspace incident from Phase 2 is still open in the local database, so it shows on the ADMIN dashboard.
- Vault update skipped: local dev stack only, nothing deployed.
