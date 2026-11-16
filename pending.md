# Pending items (2026-11-16)

State: Pulse is live as `3a9a5a1` on pulse.termspace.dev (185.92.183.106). Details of what changed are in `PHASE_4B_NOTES.md`.

## Waiting on you
- [ ] **Confirm the Telegram recovery edit.** The alert-test message on your phone should now read "recovered". Only inferred from the database so far.
- [ ] **Lock down SSH on 185.92.183.106.** Add your key to the `deploy` user first and confirm `ssh deploy@185.92.183.106` works (key login was refused earlier). Then change the root password and disable root and password login (`deploy/README.md`, "Optional: lock down SSH"). Deploys afterwards go through `deploy` and your key.
- [ ] **Decide on the roco-seo API check.** The API is private (`http://api:4000` inside Compose); `scc.rocobroker.com/health` and `/ready` return 404.
  - Option 1: leave it. The job heartbeats are the only signal, so a dead API, database or queue goes unseen.
  - Option 2: expose `/health` and `/ready` through nginx, allowed only from 185.92.183.106. Then add the two checks to `targets.yaml`. `/ready` returns `{"status":"ready"}`, so it needs `assertions: [{ path: "$.status", equals: "ready" }]`.
- [ ] **#1 Client portal `/health`.** Needs the portal's repo path. Requirements: `db`, `redis` and cached AXIS, MT5 and payment-gateway checks (cached, so Pulse polling never hits vendors directly), a shared-token header, no bodies, credentials, wallet addresses or personal data in logs. Pulse side: `PORTAL_HEALTH_TOKEN` in `/opt/pulse/.env`; the JSON check already supports `token_header` / `token_env` and turns `checks.*.status` into degraded or down.
- [ ] **#6 Midori backend `/health`.** Needs the repo path. `https://13.140.89.146/health` returns only `{"status":"ok"}`. Add `checks.db` so a running but broken backend shows as down.
- [ ] **DKIM selectors.** Both `default` and `k1` are published and checked. Do you send with both? Drop the unused check from `roco-email`.
- [ ] **Calendar reminder for rocobroker.ir.** `.ir` domains do not auto-renew and domain checks were removed.
- [ ] **Untracked `AGENTS.md` in the repo root.** Not created by this work. Commit, ignore or delete it.
- [ ] Optional: stop the local dev containers (`docker compose -f docker-compose.yml -f docker-compose.dev.yml down`). The repo has a git-ignored dev-only `.env`.
- [ ] Optional: rotate the Telegram bot token (`/revoke` in BotFather) if the chat transcript is stored anywhere shared.

## Watch
- [ ] **First real roco-seo heartbeats.** GSC 04:15 UTC and GA4 04:45 UTC daily (heartbeats expire 25 h after the last ping, so 13:06 UTC on 2026-11-17 if the 04:15 and 04:45 runs do not ping); PageSpeed Mondays 05:15 UTC (next: 2026-11-23, grace 8 days). Check with `pnpm heartbeat list` on the server.
- [ ] **Healthchecks.io.** Confirm the `Pulse watchdog` check shows "up". The "stop Pulse, watchdog alerts" test in `deploy/README.md` section 7 has never been run, and the core connectivity canary depends on that alert path.
- [ ] **Not verified on live Telegram:** host grouping and the "removed while down" edit were tested against the fake Bot API only. A live test needs two temporary heartbeat targets with the same `host` failing together (same method as the earlier alert test).
- [ ] **Email fallback is off.** If Telegram is unreachable nobody is told; Healthchecks only covers Pulse itself dying. Setting `SMTP_*` adds a fallback.
- [ ] **Main-site latency.** Seen at 1940 ms against the 2000 ms degraded threshold. If it flaps, raise `latency_degraded_ms` on that check.
