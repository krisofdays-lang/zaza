#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Zero-downtime rolling update for the `app` service behind Caddy.
#
# Blue/green at the container level: build the new image, start replacement
# replicas ALONGSIDE the old ones, wait until the new ones report healthy, then
# retire the old ones. Caddy load-balances across whatever is healthy the whole
# time (see Caddyfile), so users never hit a dead server.
#
# Usage:   ./scripts/rolling-update.sh
# Requires: bash, docker compose v2. Data (Postgres volume, media volume) is
# untouched — only the app containers are swapped.
# ---------------------------------------------------------------------------
set -euo pipefail

SERVICE=app
COMPOSE="docker compose"

cd "$(dirname "$0")/.."

echo "==> Building new image for '$SERVICE'"
$COMPOSE build "$SERVICE"

# Snapshot the currently running replica container IDs.
mapfile -t OLD < <($COMPOSE ps -q "$SERVICE")
CURRENT=${#OLD[@]}

if [ "$CURRENT" -eq 0 ]; then
  echo "==> Nothing running yet; starting the stack"
  $COMPOSE up -d
  exit 0
fi
echo "==> $CURRENT replica(s) currently serving"

TARGET=$((CURRENT * 2))
echo "==> Scaling '$SERVICE' up to $TARGET so new replicas join with the new image"
# --no-recreate keeps the existing (old-image) containers running; the extra
# replicas are created from the freshly built image. --scale overrides the
# deploy.replicas value in the compose file for the duration of the deploy.
$COMPOSE up -d --no-deps --no-recreate --scale "$SERVICE=$TARGET" "$SERVICE"

echo "==> Waiting for all $TARGET replicas to become healthy"
deadline=$(( $(date +%s) + 180 ))
while :; do
  healthy=0
  for id in $($COMPOSE ps -q "$SERVICE"); do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo gone)
    [ "$status" = "healthy" ] && healthy=$((healthy + 1))
  done
  echo "    healthy: $healthy/$TARGET"
  [ "$healthy" -ge "$TARGET" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "!! Timed out waiting for new replicas. Rolling back to the old ones."
    # Kill everything that isn't one of the original OLD containers.
    for id in $($COMPOSE ps -q "$SERVICE"); do
      keep=0
      for old in "${OLD[@]}"; do [ "$id" = "$old" ] && keep=1; done
      [ "$keep" -eq 0 ] && docker rm -f "$id" >/dev/null 2>&1 || true
    done
    $COMPOSE up -d --no-deps --no-recreate --scale "$SERVICE=$CURRENT" "$SERVICE"
    exit 1
  fi
  sleep 3
done

echo "==> New replicas healthy; retiring the old ones"
for id in "${OLD[@]}"; do
  # `stop` respects stop_grace_period so in-flight requests drain first.
  docker stop "$id" >/dev/null && docker rm "$id" >/dev/null
  echo "    retired ${id:0:12}"
done

echo "==> Normalising replica count back to $CURRENT"
$COMPOSE up -d --no-deps --no-recreate --scale "$SERVICE=$CURRENT" "$SERVICE"

echo "==> Done. Zero-downtime update complete."
