#!/usr/bin/env bash
# Deploy a release tarball on the core VPS. Run as the deploy user:
#   /opt/pulse/deploy.sh /tmp/pulse-<tag>.tar.gz
# The tarball is `git archive` output. Each release gets its own directory and image tag; the shared state
# (/opt/pulse/.env, the Postgres/Redis/Caddy volumes) lives outside it. If the new stack is not healthy within
# the timeout, the previous release is started again (its images are still on disk).
set -euo pipefail

TARBALL="${1:?usage: deploy.sh <pulse-TAG.tar.gz>}"
APP_DIR="${APP_DIR:-/opt/pulse}"
ENV_FILE="$APP_DIR/.env"
TIMEOUT_S="${TIMEOUT_S:-240}"
KEEP="${KEEP:-3}"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy .env.example and fill it in)" >&2; exit 1; }
[ -f "$TARBALL" ] || { echo "no such file: $TARBALL" >&2; exit 1; }

TAG="$(basename "$TARBALL" .tar.gz)"; TAG="${TAG#pulse-}"
REL="$APP_DIR/releases/$TAG"
PREV_TAG=""
[ -L "$APP_DIR/current" ] && PREV_TAG="$(basename "$(readlink "$APP_DIR/current")")"

compose() { # compose <tag> <dir> args...
  local tag="$1" dir="$2"; shift 2
  (cd "$dir" && PULSE_TAG="$tag" docker compose -p pulse -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE" "$@")
}

healthy() { # all long-running services report healthy
  local svc
  for svc in postgres redis worker web caddy; do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "pulse-$svc-1" 2>/dev/null || echo none)" = healthy ] || return 1
  done
}

mkdir -p "$REL"
tar -xzf "$TARBALL" -C "$REL"
echo "==> building $TAG"
compose "$TAG" "$REL" build
echo "==> starting $TAG"
compose "$TAG" "$REL" up -d --remove-orphans

echo "==> waiting for healthy (max ${TIMEOUT_S}s)"
ok=0
for _ in $(seq 1 "$((TIMEOUT_S / 5))"); do
  if healthy; then ok=1; break; fi
  sleep 5
done

if [ "$ok" -ne 1 ]; then
  echo "!! $TAG did not become healthy" >&2
  docker ps --format 'table {{.Names}}\t{{.Status}}' >&2
  compose "$TAG" "$REL" logs --tail 40 worker web >&2 || true
  if [ -n "$PREV_TAG" ] && [ -d "$APP_DIR/releases/$PREV_TAG" ]; then
    echo "==> rolling back to $PREV_TAG" >&2
    compose "$PREV_TAG" "$APP_DIR/releases/$PREV_TAG" up -d --remove-orphans
  fi
  exit 1
fi

ln -sfn "$REL" "$APP_DIR/current"
echo "==> $TAG is live (previous: ${PREV_TAG:-none})"

# keep the newest $KEEP releases and their images
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  t="$(basename "$old")"
  [ "$t" = "$TAG" ] && continue
  docker image rm "pulse-web:$t" "pulse-worker:$t" >/dev/null 2>&1 || true
  rm -rf "$old"
done
docker image prune -f >/dev/null
