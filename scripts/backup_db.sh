#!/usr/bin/env bash
# Daily Postgres backup for MeshInfo.
#
# pg_dump custom format (-Fc is already compressed — no gzip), validated with
# pg_restore --list before being trusted, pruned to keep_days locally, and
# optionally pushed off-box. The archive is keep-forever (#526), so backups are
# the only copy of history — run this from host cron:
#
#   0 4 * * *  /opt/meshinfo/scripts/backup_db.sh >> /var/log/meshinfo-backup.log 2>&1
#
# Settings come from config.toml's [backups] section (keep_days, dir,
# remote_target — see config.toml.sample); environment variables BACKUP_DIR,
# KEEP_DAYS, REMOTE_TARGET, CONTAINER, DB_USER, DB_NAME override it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_TOML="${CONFIG_TOML:-$REPO_ROOT/config.toml}"

# Pull [backups] settings out of config.toml (env vars still win below).
CFG_KEEP_DAYS="" CFG_DIR="" CFG_REMOTE=""
if [ -f "$CONFIG_TOML" ] && command -v python3 >/dev/null 2>&1; then
  eval "$(python3 - "$CONFIG_TOML" <<'PY'
import shlex, sys, tomllib
cfg = tomllib.load(open(sys.argv[1], "rb")).get("backups", {})
for var, key in (("CFG_KEEP_DAYS", "keep_days"), ("CFG_DIR", "dir"), ("CFG_REMOTE", "remote_target")):
    value = cfg.get(key)
    if value not in (None, ""):
        print(f"{var}={shlex.quote(str(value))}")
PY
)"
fi

KEEP_DAYS="${KEEP_DAYS:-${CFG_KEEP_DAYS:-4}}"
BACKUP_DIR="${BACKUP_DIR:-${CFG_DIR:-backups}}"
case "$BACKUP_DIR" in /*) ;; *) BACKUP_DIR="$REPO_ROOT/$BACKUP_DIR" ;; esac
REMOTE_TARGET="${REMOTE_TARGET:-${CFG_REMOTE:-}}"
CONTAINER="${CONTAINER:-meshinfo-postgres-1}"
# Same env names the migrate-*.sh scripts honor.
DB_USER="${DB_USER:-${POSTGRES_USER:-postgres}}"
DB_NAME="${DB_NAME:-${POSTGRES_DB:-meshinfo}}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/meshinfo-pg-$STAMP.dump"

docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc --no-owner --no-privileges "$DB_NAME" > "$OUT.tmp"
docker exec -i "$CONTAINER" pg_restore --list < "$OUT.tmp" > /dev/null
mv "$OUT.tmp" "$OUT"
echo "$(date -u +%FT%TZ) backup ok: $OUT ($(du -h "$OUT" | cut -f1))"

find "$BACKUP_DIR" -name 'meshinfo-pg-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'meshinfo-pg-*.dump.tmp' -mtime +1 -delete

if [ -n "$REMOTE_TARGET" ]; then
  rsync -az "$OUT" "$REMOTE_TARGET/"
  echo "$(date -u +%FT%TZ) pushed to $REMOTE_TARGET"
fi
