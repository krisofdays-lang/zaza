#!/usr/bin/env bash
#
# Restore (roll back) the Orbit database from a backup created by backup-db.sh.
#
# Usage:
#   ./scripts/restore-db.sh /srv/orbit-backups/orbit_2026-06-30_030000.sql.gz
#
# The dump was made with `pg_dump --clean --if-exists`, so it drops and
# recreates objects as part of the restore — no manual cleanup needed.
#
# WARNING: this OVERWRITES the current database with the contents of the dump.

set -euo pipefail

DB_SERVICE="${DB_SERVICE:-db}"
POSTGRES_USER="${POSTGRES_USER:-orbit}"
POSTGRES_DB="${POSTGRES_DB:-orbit}"

cd "$(dirname "$0")/.."

dump="${1:-}"
if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  echo "Usage: $0 <path-to-dump.sql.gz>" >&2
  echo "Available backups:" >&2
  ls -1 "${BACKUP_DIR:-/srv/orbit-backups}"/orbit_*.sql.gz 2>/dev/null >&2 || echo "  (none found)" >&2
  exit 1
fi

echo "[restore] This will OVERWRITE database '$POSTGRES_DB' with:"
echo "          $dump"
read -r -p "[restore] Type 'yes' to continue: " confirm
if [ "$confirm" != "yes" ]; then
  echo "[restore] aborted"
  exit 1
fi

echo "[restore] restoring..."
gunzip -c "$dump" | docker compose exec -T "$DB_SERVICE" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo "[restore] done. Restart the app to pick up a clean connection pool:"
echo "          docker compose restart app"
