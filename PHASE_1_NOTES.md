# Phase 1 notes — Checkers + scheduler

## Built
- `packages/core/src/checkers/`: `http`, `json`, `tls`, `domain`, `dns`, `tcp`, `smtp`, each a `Checker<Cfg>` (written by one subagent per kind, then reviewed as a whole). Registry in `checkers/index.ts`; per-kind Zod config schemas and `DEFAULT_INTERVAL_S` in `checkers/config.ts`; shared helpers (`USER_AGENT`, `raceAbort`, `timeoutResult`, `daysUntil`) in `checkers/util.ts`.
- `targets.yaml` check `config` is now validated per kind (strict) by `pnpm validate:targets`; passive kinds (heartbeat/agent/queue) stay free-form until Phase 4/5.
- `packages/core/src/testing/fixture-server.ts`: local HTTP, TLS (valid/expired/wrong-host/expiring-soon) and TCP fixtures. TLS certs come from the `selfsigned` devDependency, not mkcert (not installed here, and no external binary is needed).
- `apps/worker`: `run-check.ts` (runs one check, never throws, caps timeout at 10 s), `scheduler.ts` (BullMQ job schedulers, one queue `pulse-checks`, concurrency 10, +-10 % jitter applied once per check at registration because BullMQ `every` is fixed), `cli.ts` (`pnpm check [<target-id>|all]`). The worker logs each result as JSON; nothing is stored yet (Phase 2). `SCHEDULER_ENABLED=false` turns it off.

## Verification
- `pnpm test`: 74 passing in 11 files. Per-checker suites cover 200, 500, 404, slow, redirects, keyword, expired / wrong-host / expiring cert, SMTP with and without STARTTLS, DNS and abort handling. No real network in unit tests.
- `pnpm typecheck`: clean. `pnpm validate:targets`: ok (8 targets).
- `pnpm check all` against the real targets, run from this Windows machine in Turkey:
  - up: rocobroker.com (HTTP, TLS, DNS), email SPF/DMARC DNS, HostVDS SSH port
  - degraded: both domain-expiry checks (`expiry unknown: timeout`)
  - down: SMTP on `mail.rocobroker.com:587` (timeout); `client.rocobroker.ir` HTTP/TLS (`ECONNRESET`); termspace and cPanel (placeholder `.example` hosts, marked `*`)
- `docker compose up -d --build`: all 5 services healthy, scheduler registered 16 checks. From inside Docker, `client.rocobroker.ir` returned HTTP 200 and TLS up, so the host-side `ECONNRESET` is specific to the Windows host's network path (supports the two-vantage design).

## Fixed during review
- http/json (and the domain RDAP fetch) overshot their timeout: undici does not abort during DNS/connect. Fixed with `raceAbort` plus an own AbortController; regression test `abort.test.ts` (mocked undici, no network).
- domain returned `down` on timeout; now `degraded` ("expiry unknown"), since a failed lookup must not page. Only a known past expiry is `down`.
- `tls` results lacked `latencyMs` on some paths; scheduler now has `error` listeners on Queue/Worker and a guarded `onResult`.
- `startTcpFixture.close()` hung until sockets closed; it now destroys its sockets.

## Known limits / carry-overs
- Domain expiry lookups (RDAP / whois, `.ir` via whois.nic.ir:43) are slow or blocked from here and only return `degraded`. Real-server parsing is covered by sample-text tests only. Revisit from the core VPS in Phase 4; may need a longer per-check timeout (hard cap is 10 s).
- `dns` cannot cancel an in-flight query; a timed-out lookup keeps running until it finishes. `expect` entries must be written without trailing dots (e.g. `10 mail.example.com`).
- roco-seo `/health` (liveness) and `/ready` (readiness: DB + queue) are not exposed publicly yet (`scc.rocobroker.com` is the Next.js frontend and returns 404). Decision: add these checks at the end of the project; TODO note is in `targets.yaml`.
- SMTP `mail.rocobroker.com` (MX host, same IP as cPanel) accepts TCP on 25/465/587 but sends no banner within 9 s from both the Windows host and Docker. Checker is correct; the server or its firewall is not greeting. Investigate server-side.
- termspace `/ar` and `/en` return 404 on the sslip.io host; only `/fa` and `/` return 200.
- cPanel checks now use `host1.rocobroker.com:2087/` (cert is for that name, not the IP).
- Still unknown: shared Ubuntu VPS IP (agent check, Phase 5).
- Jitter is per-check at registration, not per-run (BullMQ limitation).
- Check results are only logged; storage, state machine and incidents are Phase 2.
- Vault update skipped: nothing deployed.
