#!/usr/bin/env bash
#
# Daily PostgreSQL backup for the Orbit deployment.
#
# Dumps the database that runs inside the `db` Docker container and writes a
# compressed dump to a directory ON THE HOST (outside Docker volumes). This
# means the backups survive even a `docker compose down -v` that wipes the
# database volume — so you can always roll back.
#
# Usage:
#   ./scripts/backup-db.sh                 # uses defaults below
#   BACKUP_DIR=/srv/orbit-backups ./scripts/backup-db.sh
#
# Designed to be run from cron once a day (see DEPLOYMENT.md).

set -euo pipefail

# --- Config (override via env) ---------------------------------------------
# Directory on the HOST where dumps are stored. Keep this on a path that is NOT
# a Docker volume (e.g. /srv/orbit-backups or a mounted backup disk).
BACKUP_DIR="${BACKUP_DIR:-/srv/orbit-backups}"
# How many daily dumps to keep before deleting the oldest.
RETENTION_DAYS="${RETENTION_DAYS:-14}"
# Name of the compose service running Postgres.
DB_SERVICE="${DB_SERVICE:-db}"
# Postgres credentials (must match docker-compose / .env).
POSTGRES_USER="${POSTGRES_USER:-orbit}"
POSTGRES_DB="${POSTGRES_DB:-orbit}"

# Run from the project root (directory that contains docker-compose.yml), so
# `docker compose` resolves the right project regardless of where cron calls us.
cd "$(dirname "$0")/.."

mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y-%m-%d_%H%M%S)"
outfile="$BACKUP_DIR/orbit_${timestamp}.sql.gz"

echo "[backup] dumping database '$POSTGRES_DB' -> $outfile"

# --clean --if-exists makes the dump self-restoring: it drops existing objects
# before recreating them, so a restore is a single clean pipe.
# -T runs without a TTY so it works under cron.
docker compose exec -T "$DB_SERVICE" \
  pg_dump --clean --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip -c > "$outfile"

# Fail loudly if the dump came out empty/broken.
if [ ! -s "$outfile" ]; then
  echo "[backup] ERROR: dump is empty, removing $outfile" >&2
  rm -f "$outfile"
  exit 1
fi

echo "[backup] ok: $(du -h "$outfile" | cut -f1) written"

# --- Rotation: delete dumps older than RETENTION_DAYS ----------------------
deleted="$(find "$BACKUP_DIR" -name 'orbit_*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')"
if [ "$deleted" != "0" ]; then
  echo "[backup] rotated out $deleted dump(s) older than ${RETENTION_DAYS} days"
fi

echo "[backup] done"
