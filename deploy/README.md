# Deploying Pulse

Core stack on one Ubuntu VPS (Docker Compose: `web`, `worker`, `postgres:16`, `redis:7`, `caddy`), dashboard at
`https://pulse.termspace.dev`. A stateless probe on HostVDS is the second vantage.

Nothing here runs by itself: every command below is meant to be run by a person (or by Claude Code on request).

## 0. Before the first deploy

- DNS: an `A` record `pulse.termspace.dev -> <core VPS ip>`. Caddy gets the Let's Encrypt certificate on first start,
  so the record must resolve before `docker compose up`.
- A Telegram bot token from `@BotFather` (needed only when `ALERTS_ENABLED=true`).
- Optional: an SMTP account for the email fallback; a Healthchecks.io check for the watchdog.

## 1. Prepare the server (once, as root)

```bash
scp deploy/bootstrap.sh root@<core-ip>:/root/
ssh root@<core-ip> 'DEPLOY_PUBKEY="$(cat)" bash /root/bootstrap.sh' < ~/.ssh/id_ed25519.pub
```

Installs Docker, creates the non-root `deploy` user (docker group, key login), opens only 22/80/443 (ufw), enables
fail2ban and unattended security updates, and creates `/opt/pulse`. It leaves `sshd_config` alone, so password and
root logins keep working until you lock them (last section).

## 2. Configure (once, as deploy)

```bash
ssh deploy@<core-ip>
cp /opt/pulse/current/.env.example /opt/pulse/.env   # after the first upload, or copy .env.example by hand
chmod 600 /opt/pulse/.env
```

Fill in `/opt/pulse/.env`:

| Variable | Value |
| --- | --- |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `SITE_ADDRESS` | `pulse.termspace.dev` |
| `PUBLIC_URL` | `https://pulse.termspace.dev` |
| `HMAC_INGEST_SECRET` | `openssl rand -hex 32` (also goes to the probe) |
| `ALERTS_ENABLED` | leave `false` until step 5 |
| `TELEGRAM_BOT_TOKEN`, `SMTP_*`, `WATCHDOG_URL` | when you have them |

## 3. Ship a release and deploy

From your machine, in the repo:

```bash
TAG=$(git rev-parse --short HEAD)
git archive --format=tar.gz --prefix= -o /tmp/pulse-$TAG.tar.gz HEAD
scp /tmp/pulse-$TAG.tar.gz deploy/deploy.sh deploy/backup.sh deploy@<core-ip>:/tmp/
ssh deploy@<core-ip> 'install -m 755 /tmp/deploy.sh /tmp/backup.sh /opt/pulse/ && /opt/pulse/deploy.sh /tmp/pulse-'$TAG'.tar.gz'
```

`deploy.sh` builds the images tagged with the release, starts the stack, waits until all five services are healthy
and then points `/opt/pulse/current` at the release. **If the stack is not healthy within 4 minutes it starts the
previous release again** and exits non-zero. The worker applies database migrations on boot (they are reversible:
`pnpm migrate down 1` with `DATABASE_URL` set undoes the last one).

First user (there is no sign-up page):

```bash
docker exec -it pulse-web-1 true   # the web image has no CLI; run the CLI from a release checkout instead:
cd /opt/pulse/current && docker compose -p pulse -f docker-compose.yml -f docker-compose.prod.yml --env-file /opt/pulse/.env \
  run --rm --no-deps -e DATABASE_URL="postgres://pulse:<POSTGRES_PASSWORD>@postgres:5432/pulse" worker \
  pnpm --filter @pulse/db user create you@example.com --role ADMIN
```

The command prints the TOTP secret and `otpauth://` URI once: add it to your authenticator app.

## 4. Backups

```bash
crontab -e   # as deploy
17 3 * * * /opt/pulse/backup.sh >> /opt/pulse/backups/backup.log 2>&1
```

Keeps 14 days on the box. Set `BACKUP_REMOTE=user@host:/path` in `.env` to copy every dump off the machine.
Restore: `gunzip -c pulse-<stamp>.sql.gz | docker exec -i pulse-postgres-1 psql -U pulse -d pulse` into an empty database.

## 5. Turn on alerts

1. Create the bot with `@BotFather`, put the token in `.env`, set `ALERTS_ENABLED=true`, then
   `docker compose -p pulse -f docker-compose.yml -f docker-compose.prod.yml --env-file /opt/pulse/.env up -d worker`
   (from `/opt/pulse/current`).
2. Each user: sign in, open **Profile**, press **Generate link code**, send `/start <code>` to the bot.
3. ADMIN only: `/mute <target> 2h`, `/unmute <target>`, `/mutes`.
4. Kill switch: `ALERTS_ENABLED=false` and recreate the worker. Incidents keep being recorded.

Heartbeats (cron jobs, workers): after the first start the worker has synced the `heartbeat` checks.

```bash
pnpm heartbeat create roco-seo:0:heartbeat   # prints the push URL once; rotate = run create again
# in the job:  curl -fsS -X POST https://pulse.termspace.dev/api/push/<token>   (failure: ?status=fail)
```

## 6. Second vantage on HostVDS

Needs Docker on HostVDS. Copy the same release tarball there and:

```bash
mkdir -p ~/pulse-probe && tar -xzf pulse-$TAG.tar.gz -C ~/pulse-probe && cd ~/pulse-probe/deploy/probe
cp .env.example .env && nano .env     # HMAC_INGEST_SECRET must equal the core's
docker compose --env-file ./.env up -d --build
docker compose logs -f probe
```

The probe has no published ports and talks only to `CORE_INGEST_URL`. Requests carry a timestamp and a one-time
nonce, signed with HMAC-SHA256 (60 s clock window), so a captured request cannot be replayed. Keep the clocks on both
servers in sync (`timedatectl`).

## 7. Watchdog

Create a check at Healthchecks.io with a 1 minute period and a few minutes of grace, send its alerts to Telegram or
email, and put its ping URL in `WATCHDOG_URL`. Pulse pings it every minute **only while** Postgres and Redis answer and
the scheduler has produced a result in the last 5 minutes. To test: `docker stop pulse-worker-1` and wait for the alert.

## Rollback

- Failed deploy: automatic (see step 3).
- Later: `cd /opt/pulse/releases/<older-tag> && PULSE_TAG=<older-tag> docker compose -p pulse -f docker-compose.yml -f docker-compose.prod.yml --env-file /opt/pulse/.env up -d` then `ln -sfn /opt/pulse/releases/<older-tag> /opt/pulse/current`.
- A migration: `pnpm migrate down 1` (needs `DATABASE_URL`), then deploy the older release.

## Optional: lock down SSH

Only after you have confirmed `ssh deploy@<core-ip>` works with your key:

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sshd -t && sudo systemctl reload ssh
```

Keep the existing session open while you test a second one.
