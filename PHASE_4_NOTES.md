# Phase 4 notes — Telegram alerts, heartbeats, second vantage, deployment

## Built
- **Deployment files** (`deploy/`, `docker-compose.prod.yml`, `Caddyfile`): `bootstrap.sh` (root, once: Docker, non-root `deploy` user, ufw 22/80/443, fail2ban, unattended upgrades; does not touch `sshd_config`), `deploy.sh` (release tarball -> per-release image tags -> wait for 5 healthy services -> automatic rollback to the previous release), `backup.sh` (nightly `pg_dump`, 14 days local, optional `scp` off-box), `deploy/probe/` (HostVDS probe compose), `deploy/README.md` (every command, in order). Caddy adds security headers and a 256 KB body cap; `SITE_ADDRESS` is mandatory in the prod override.
- **Telegram bot** (`apps/worker/src/alerts/`): long polling (no webhook, no inbound port).
  - Linking: Profile page -> "Generate link code" (8 chars, only the hash is stored in Redis for 10 min) -> `/start <code>`. Codes are single use, guessing is throttled to 5 per chat per 15 min, private chats only, and a chat can belong to one account (unique index).
  - Routing: the notifier uses the same `canSee()` rule as `scopeTargets`, so ADMIN gets everything and USER only roco targets. Tests assert a USER chat never receives or has edited any message naming an admin target.
  - One message per incident and user, edited in place on resolve. The notifier is driven by database state (`alert_messages`, unique per incident+user), not by in-process events: a crash, restart or Telegram outage only delays a message, and a recovery is never announced for an outage nobody was told about.
  - `/mute <target> <duration>`, `/unmute`, `/mutes`: ADMIN only, 1 minute to 7 days, target by id, name or unique substring. A muted target (and YAML `maintenance` windows) is still recorded as an incident but not announced; when the mute ends, a still-open incident is announced.
  - Daily digest at 09:00 `Asia/Tehran` (BullMQ job scheduler with `tz`): open incidents, degraded items, TLS/domain expiries, scoped per user.
  - Degraded > 15 min gets a notice (edited when it clears).
- **Email fallback** (`nodemailer`): used only when a Telegram send fails after 3 attempts, or a resolve edit fails. A user with no linked chat gets nothing.
- **Heartbeat push** `POST /api/push/:token` (`?status=fail&message=` or JSON): secret token in the URL, only its SHA-256 is stored, unknown/malformed tokens get the same 404, rate limited per address. `pnpm heartbeat create <checkId>` prints the URL once (running it again rotates). The worker evaluator turns silence beyond `grace_s` (or a reported failure) into ordinary results, so it goes through the same 3-fail / 2-pass state machine. Heartbeat checks are now synced to `checks` and shown on the dashboard.
- **Second vantage**: `PROBE_ONLY=1` runs a stateless in-process scheduler (no Postgres/Redis, concurrency <= 10) and POSTs to `POST /api/ingest`. Signature = HMAC-SHA256 over `timestamp.nonce.body`; accepted only within a 60 s clock window and each nonce once (Redis `SET NX`). Ingest only accepts checks that list the sending vantage, refuses `core`/`push` as vantage names, drops results older than 5 min, caps the body at 64 KB / 200 results.
- **Multi-vantage recording**: a round of the state machine is clocked by the core's result; other vantages contribute their freshest result (ignored when older than max(3 intervals, 3 min), or not listed in `vantage`). A minority down is "regional": stored as `degraded` with the message `regional: down from <vantage>`, never an incident. With two vantages a tie is regional, so an incident needs both down.
- **Watchdog**: GET `WATCHDOG_URL` every minute, but only while Postgres and Redis answer and the scheduler stored a result in the last 5 min.
- **`ALERTS_ENABLED`** (must be exactly `true`) gates the bot, notifier, email, digest and watchdog. Heartbeat push, ingest and the probe are data collection and stay on. Enabling without `TELEGRAM_BOT_TOKEN` fails at startup.
- Migration `0003_alerts` (reversible): `alert_messages`, `mutes`, heartbeat state columns, unique `telegram_chat_id`, unique heartbeat per check.

## Verification
- `pnpm typecheck` clean. `pnpm test:db`: **206 passed** (22 files), including the generic migration up/down/up test and the schema drift test for `0003`.
- Unit: signing/replay/skew, durations, message escaping, command parsing, Telegram client retry rules, watchdog gating, `ALERTS_ENABLED=false` touches no dependency.
- Integration (real Postgres + Redis, fake Bot API): routing by role, edit-in-place, no duplicates after a notifier restart, mutes/expiry/maintenance, email only on Telegram failure, bot linking and authorization, heartbeat lifecycle, regional vs. real outage vs. stale probe vs. unexpected vantage, ingest accept/reject matrix.
- `boundary.test.ts` extended on purpose: `server/ingest.ts` is an allowed data module; `/api/push` and `/api/ingest` are the only handlers without a viewer and must authenticate through `server/ingest.ts`; the middleware allowlist is checked.
- **Playwright** `pnpm test:e2e` now runs two isolated stacks. Dashboard suite: 10/10 unchanged. Alerts suite (real worker, real `PROBE_ONLY` process, fake Telegram, 2.3 min): 10/10.
  - both users link from the Profile page; stopping the Roco fixture -> exactly one message each, edited (same message id) to "recovered" on restart
  - stopping the admin-only fixture -> ADMIN message only, nothing about it ever reaches the USER chat
  - a blocked probe (simulated vantage says down for 35 s while core is up) -> `degraded`, `regional: down from e2e-sim`, no incident, no message
  - `/mute` by USER -> "Not allowed."; by ADMIN -> silent incident; `/unmute` -> message
  - heartbeat push 200 / fail / 404; `/api/ingest` rejects unsigned, wrong key, replay, old timestamp; watchdog pinged >= 2 times
- Deploy files: `bash -n` on all scripts, `docker compose ... config` for prod and probe, `caddy validate` (with and without `SITE_ADDRESS`).

## Not verified (needs the real thing)
- A real Telegram bot, real SMTP, a real Healthchecks.io check ("stop Pulse -> watchdog alerts" is a manual step, see `deploy/README.md` section 7), the HostVDS probe, and the deploy scripts on a real Ubuntu server (only syntax/compose/caddy checks so far). No `shellcheck` on this machine.
- Lighthouse was not re-run (new Profile page only).

## Deviations / decisions
- Reconcile-driven notifier instead of event-driven sends (see above); `ALERTS_RECONCILE_MS` (default 30 s) is the delivery latency.
- Regional degradation never pages, even when it lasts > 15 min (PLAN: "no page"); it shows in the digest.
- Heartbeat detection time is grace + 3 evaluations (the evaluator runs every 60 s).
- `check_results` from all vantages feed the hourly rollup, so a probe-only failure lowers the 90-day uptime bar even though it opened no incident.
- The user-owned uncommitted `user:dev` script (`package.json`, `scripts/user-dev.mjs`) is included in this commit because `package.json` also carries the new `heartbeat` script.
- Per-IP rate limits use the first `X-Forwarded-For` value set by Caddy. Behind a proxied Cloudflare record all clients would share the edge IP, so the domain should be DNS-only.

## Deployment status (2026-11-01)
Live at https://pulse.termspace.dev on **185.92.183.106** (Ubuntu 24.04, 1 vCPU / 2 GB / 2 GB swap). 31.59.120.14 was unreachable from the dev machine (no answer on any port), so this server replaced it.
- Bootstrapped with `deploy/bootstrap.sh` (Docker 29, `deploy` user with key login, ufw 22/80/443, fail2ban, swap). Secrets in `/opt/pulse/.env` (mode 600) were generated on the server and never printed.
- Release d7cac5d built and started; the deploy script reported failure because **Caddy's healthcheck requested `http://127.0.0.1/…`, which a real hostname redirects to HTTPS** (no certificate for an IP). Fixed in 7119deb (healthcheck uses Caddy's admin API) and redeployed: all 5 services healthy, `deploy.sh` reported "7119deb is live". The failure path itself was therefore exercised once (with no previous release, so no rollback).
- Let's Encrypt certificate issued (valid to 2027-01-30). Verified from outside: HTTP -> HTTPS 308; `/`, `/profile` redirect to login; `/api/status.json`, `/api/incidents`, `/api/stream` 401; unknown push token 404; unsigned `/api/ingest` 401; HSTS, nosniff, frame-deny, noindex headers; migrations 0001-0003 applied.
- The record had to be DNS-only (it first resolved to Cloudflare proxy addresses).
- Nightly backup cron installed (03:17 UTC) and a first dump verified.
- `.gitattributes` (`eol=lf`) added: `git archive` was emitting CRLF for the shell scripts because of `core.autocrlf`.

## Still to do (needs you)
1. Create the ADMIN account (interactive, so the password and TOTP secret stay out of chat logs); command below.
2. Telegram: BotFather token -> `TELEGRAM_BOT_TOKEN` and `ALERTS_ENABLED=true` in `/opt/pulse/.env`, recreate the worker, link chats from Profile.
3. Probe on HostVDS (`deploy/probe/`, same `HMAC_INGEST_SECRET` as `/opt/pulse/.env`); watchdog (`WATCHDOG_URL`); optional SMTP.
4. Lock down SSH (disable root/password login) and rotate the root password that was shared in chat.
5. Real-target findings from the new vantage: `termspace` checks fail with a certificate name mismatch (the sslip.io hostname), and `roco-email` SMTP 465 to mail.rocobroker.com times out from this VPS (outbound 465 is probably filtered; confirm with the provider or use 587).

```bash
ssh deploy@185.92.183.106
cd /opt/pulse/current && set -a && . /opt/pulse/.env && set +a
docker compose -p pulse -f docker-compose.yml -f docker-compose.prod.yml --env-file /opt/pulse/.env run --rm --no-deps   -e DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB" worker   pnpm --filter @pulse/db user create you@example.com --role ADMIN
```
