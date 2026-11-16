# Phase 4b notes — registry rework, self-monitoring, alert grouping (2026-11-16)

Not a phase from `docs/PLAN.md`: a rework of what Pulse watches, plus the hardening that fell out of it.

## Changed
- **Registry** (`targets.yaml`): hosts moved, 4 targets retired (HostVDS VPS, shared Ubuntu VPS, cPanel server; `pulse-dashboard` was removed and later restored), 5 added (blog, rocobroker.ir, Midori backend, cp.midoripuzzle.com, midoripuzzle.com). Domain-expiry checks and the SMTP check are gone from every target. Core is the only vantage.
- **TLS checker**: skips SNI when the host is an IP. Node rejects an IP as `servername`, so the Midori backend (`https://13.140.89.146`, Let's Encrypt IP certificate) could not be checked at all. The IP SAN is still verified.
- **Explicit check ids**: a check may set `id:`, stored as `<target>:<id>`. Without it the id is positional (`<target>:<index>:<kind>`) as before, so existing history is kept. New checks should always set `id`. Duplicate ids within a target are rejected by the schema.
- **Per-job heartbeats** for roco-seo (`gsc`, `ga4`, `pagespeed`), plus MX and DKIM (`default`, `k1`) checks, a `/wp-json/` check on the blog and a keyword on the main site.
- **Core connectivity canary** (`apps/worker/src/canary.ts`): a non-up result is dropped (no row, no state change) while core cannot reach 1.1.1.1 or 8.8.8.8 on 443. The watchdog stops pinging, so Healthchecks.io reports "core offline". Probe results are cached for 15 s.
- **Self-monitoring**: `WATCHDOG_URL` is set (Healthchecks.io, delivering to Telegram by their own bot), `ALERTS_ENABLED=true`, `TELEGRAM_BOT_TOKEN` set. All three live only in `/opt/pulse/.env`.
- **`syncTargets`** now closes the open incidents and deletes the heartbeat rows of checks that leave the registry. `incidents` and `heartbeats` have no FK to `checks`, so before this a removed check left an open incident and a heartbeat evaluated for nothing (the old roco-seo heartbeat had an incident open for two weeks). *An earlier note of mine that removal "deletes history" was wrong: result rows were only ever orphaned, and age out with the partitions.*
- **One Telegram message per host**: incidents on targets sharing a `host` share one message (rows with the same `chat_id` + `message_id`), edited as targets join and recover. Role scoping applies before grouping, so a USER never sees an admin target in a group, and messages never show a host or IP.
- **Removed while down**: migration `0004_alert_snapshot` (additive, nullable; `down.sql` drops the two columns) stores `target_name` and `check_kind` with each alert message. When its check leaves the registry the message is edited to "removed from monitoring" instead of staying on DOWN forever.
- **`/api/ingest` switched off**: `HMAC_INGEST_SECRET` removed from the server `.env` (old file kept as `.env.bak-*`, mode 600), so the endpoint answers 503. Restore the line and redeploy to re-enable a probe.

## Verification
- `pnpm test:db`: 23 files, 219 tests (new: explicit ids, duplicate ids, IP-host TLS, canary cache, sync cleanup, 5 grouping/removal scenarios incl. USER-vs-admin visibility, group/removal formatting). Migration up/down/up and the schema drift test cover `0004`.
- Live on the real server: down alert delivered to Telegram, resolved by editing the same message (single message row), roco-seo heartbeats pinging, removal of the throwaway `alert-test` target left no rows behind.

## Not verified
- Host grouping on live Telegram (only against the fake Bot API): needs two targets on one host to fail together.
- The "removed while down" edit on live Telegram (fake API only).
- Healthchecks.io actually alerting when Pulse stops (`deploy/README.md` §7 manual step).
- First scheduled roco-seo runs (04:15 / 04:45 UTC, Monday 05:15 UTC for PageSpeed) reporting through the new env vars.

## Still to do
See the open-items list in the conversation: SSH lockdown, API `/health` exposure decision, client portal and Midori `/health` endpoints, SMTP email fallback, rotating secrets that were pasted into chat.
