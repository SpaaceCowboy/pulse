#!/usr/bin/env bash
# Nightly Postgres dump. Run as the deploy user from cron:
#   17 3 * * * /opt/pulse/backup.sh >> /opt/pulse/backups/backup.log 2>&1
# Keeps 14 days locally. Set BACKUP_REMOTE (e.g. user@host:/backups/pulse) in /opt/pulse/.env to also copy each
# dump off the box with scp; a backup that lives only on the machine it protects is not a backup.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/pulse}"
OUT_DIR="$APP_DIR/backups"
set -a; . "$APP_DIR/.env"; set +a

umask 077
stamp="$(date -u +%Y%m%d-%H%M)"
file="$OUT_DIR/pulse-$stamp.sql.gz"
docker exec pulse-postgres-1 pg_dump -U "${POSTGRES_USER:-pulse}" -d "${POSTGRES_DB:-pulse}" --no-owner | gzip -9 > "$file.tmp"
# a dump that is not a plausible size is a failed dump
[ "$(stat -c %s "$file.tmp")" -gt 1024 ] || { echo "dump suspiciously small, keeping the old backups" >&2; rm -f "$file.tmp"; exit 1; }
mv "$file.tmp" "$file"
echo "$(date -u +%FT%TZ) wrote $file ($(stat -c %s "$file") bytes)"

if [ -n "${BACKUP_REMOTE:-}" ]; then
  scp -q -o BatchMode=yes -o ConnectTimeout=15 "$file" "$BACKUP_REMOTE/" && echo "copied to $BACKUP_REMOTE"
fi

find "$OUT_DIR" -name 'pulse-*.sql.gz' -mtime +14 -delete
