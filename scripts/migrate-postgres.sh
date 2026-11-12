#!/usr/bin/env bash
#
# migrate-postgres.sh — upgrade the MeshInfo Postgres data volume to a new
# PostgreSQL major version.
#
# PostgreSQL major versions use incompatible on-disk storage formats, so a
# newer postgres container cannot start against a volume initialised by an
# older one. This script:
#
#   1. Dumps the existing database with a temporary container running the
#      OLD PostgreSQL version (read from the volume's PG_VERSION file).
#   2. Verifies the dump, then recreates the volume empty.
#   3. Starts the NEW postgres version (from the compose file) and restores.
#
# Run this ONCE, after pulling the release that bumps the postgres image and
# BEFORE `docker compose up -d`:
#
#   git pull
#   docker compose pull
#   bash scripts/migrate-postgres.sh
#   docker compose up -d
#
# The compressed SQL dump in ./backups/ is your recovery artifact — it is
# written and integrity-checked before the volume is touched. If the restore
# fails, your data is still safe in that file (and in the backup volume when
# KEEP_VOLUME_BACKUP=1).
#
# Environment overrides:
#   COMPOSE_FILE         compose file to use (e.g. docker-compose-dev.yml)
#   PGDATA_VOLUME        Docker volume name (default: auto-detected)
#   POSTGRES_DB/USER/PASSWORD   database credentials (defaults: meshinfo/postgres/password)
#   KEEP_VOLUME_BACKUP=1 also snapshot the old volume to <volume>_oldpg_backup
#
set -euo pipefail

# Stop MSYS/Git-Bash (Windows) from rewriting container paths like `/v` or
# `/var/lib/postgresql/data` into Windows paths. Harmless no-op on Linux/macOS.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

DB_NAME="${POSTGRES_DB:-meshinfo}"
DB_USER="${POSTGRES_USER:-postgres}"
DB_PASSWORD="${POSTGRES_PASSWORD:-password}"
TMP_PG="meshinfo-pg-migrate"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP_DIR="${REPO_ROOT}/backups"
DUMP_FILE="${DUMP_DIR}/meshinfo-pg-$(date +%Y%m%d-%H%M%S).sql.gz"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }
cleanup() { docker rm -f "$TMP_PG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cd "$REPO_ROOT"

# --- Pre-flight --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { err "docker not found on PATH"; exit 1; }
docker compose version >/dev/null 2>&1 || {
  err "docker compose (v2) is required — install the Compose plugin or upgrade Docker."
  exit 1
}

# Tiered ZFS installs (ZFS.md) bind-mount datasets at /var/lib/postgresql: a
# leftover named volume would be a stale copy. Those installs follow ZFS.md.
if docker compose config 2>/dev/null | grep -A2 -E '^\s+- type: bind$' \
     | grep -qE 'target: /var/lib/postgresql$'; then
  err "The compose config bind-mounts /var/lib/postgresql (tiered ZFS install)."
  err "This script only migrates Docker named volumes — follow the Upgrades section in ZFS.md."
  exit 1
fi

# Cold-only installs (ZFS.md) bind a directory at /var/lib/postgresql/cold for
# the meshinfo_cold tablespace: the dump container needs it to read the cold months.
COLD_DIR="$(docker compose config 2>/dev/null | grep -A2 -E '^\s+- type: bind$' \
  | grep -B1 -E 'target: /var/lib/postgresql/cold$' | sed -nE 's/^\s+source: (.+)$/\1/p' | head -n1 || true)"
COLD_MOUNT=()
if [ -n "$COLD_DIR" ]; then
  log "Cold tablespace directory: $COLD_DIR (bound into the dump container as /var/lib/postgresql/cold)"
  COLD_MOUNT=(-v "${COLD_DIR}:/var/lib/postgresql/cold")
fi

VOLUME="${PGDATA_VOLUME:-}"
if [ -z "$VOLUME" ]; then
  # Auto-detect the compose pgdata volume. Refuse to guess when a host runs
  # several MeshInfo deployments — picking the wrong one here destroys data.
  MATCHES="$(docker volume ls -q | grep -E '_meshinfo_pgdata$' || true)"
  COUNT="$(printf '%s\n' "$MATCHES" | grep -c . || true)"
  if [ "$COUNT" -gt 1 ]; then
    err "Multiple candidate pgdata volumes found:"
    printf '       %s\n' $MATCHES >&2
    err "Set PGDATA_VOLUME=<name> to choose which one to migrate."
    exit 1
  elif [ "$COUNT" -eq 1 ]; then
    VOLUME="$MATCHES"
  else
    VOLUME="meshinfo_meshinfo_pgdata"
  fi
fi

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  log "Volume '$VOLUME' does not exist — fresh install, nothing to migrate."
  log "Just run: docker compose up -d"
  exit 0
fi

# On-disk catalog version of the existing cluster. postgres images ≤17 keep
# the cluster at the volume root; 18+ images use a version subdir (…/<major>/
# docker), so probe both layouts.
OLD_VER="$(docker run --rm -v "$VOLUME":/v:ro alpine sh -c \
  'cat /v/PG_VERSION 2>/dev/null || cat /v/*/docker/PG_VERSION 2>/dev/null' \
  2>/dev/null | tr -cd '0-9' || true)"
if [ -z "$OLD_VER" ]; then
  log "Volume '$VOLUME' has no initialised cluster — nothing to migrate."
  log "Just run: docker compose up -d"
  exit 0
fi

# Target version declared in the compose file.
NEW_VER="$(docker compose config 2>/dev/null | grep -oE 'postgres:[0-9]+' | head -n1 | cut -d: -f2 || true)"
if [ -z "$NEW_VER" ]; then
  err "Could not read the target postgres version from the compose file."
  err "Check the 'postgres' service image, or set COMPOSE_FILE."
  exit 1
fi

if [ "$OLD_VER" = "$NEW_VER" ]; then
  log "Volume '$VOLUME' is already at PostgreSQL ${NEW_VER} — migration not needed."
  exit 0
fi
if [ "$OLD_VER" -gt "$NEW_VER" ]; then
  err "Volume is PostgreSQL ${OLD_VER}, newer than the target ${NEW_VER}. Refusing to downgrade."
  exit 1
fi

log "Migrating volume '$VOLUME': PostgreSQL ${OLD_VER} → ${NEW_VER}"
mkdir -p "$DUMP_DIR"

# --- 1. Stop the app + database containers -----------------------------------
log "Stopping the meshinfo and postgres containers…"
docker compose rm -sf meshinfo postgres 2>/dev/null || true

# --- 2. Dump from a temporary old-version container --------------------------
log "Starting a temporary PostgreSQL ${OLD_VER} container to read the old data…"
cleanup
# postgres ≤17 expects the volume at /var/lib/postgresql/data; 18+ at the parent.
OLD_MOUNT="/var/lib/postgresql/data"
[ "$OLD_VER" -ge 18 ] && OLD_MOUNT="/var/lib/postgresql"
docker run -d --name "$TMP_PG" \
  -v "$VOLUME":"$OLD_MOUNT" \
  ${COLD_MOUNT[@]+"${COLD_MOUNT[@]}"} \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  "postgres:${OLD_VER}" >/dev/null

log "Waiting for PostgreSQL ${OLD_VER} to accept connections…"
for i in $(seq 1 60); do
  docker exec "$TMP_PG" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break
  if [ "$i" -eq 60 ]; then
    err "PostgreSQL ${OLD_VER} did not become ready."
    docker logs --tail 30 "$TMP_PG" >&2 || true
    exit 1
  fi
  sleep 1
done

# Cold-only installs: the restore puts the cold months back, uncompressed, on the
# named volume. Refuse before anything destructive when they cannot fit.
if [ -n "$COLD_DIR" ] && [ "${SKIP_SPACE_CHECK:-0}" != "1" ]; then
  DB_BYTES="$(docker exec -e PGPASSWORD="$DB_PASSWORD" "$TMP_PG" \
    psql -U "$DB_USER" -d "$DB_NAME" -Atc 'SELECT pg_database_size(current_database())' 2>/dev/null | tr -cd '0-9' || true)"
  AVAIL_BYTES="$(docker exec "$TMP_PG" df -Pk "$OLD_MOUNT" 2>/dev/null | awk 'NR==2 {printf "%d", $4 * 1024}' || true)"
  OLD_BYTES="$(docker exec "$TMP_PG" du -sk "$OLD_MOUNT" 2>/dev/null | awk '{printf "%d", $1 * 1024}' || true)"
  [ "${KEEP_VOLUME_BACKUP:-0}" = "1" ] && OLD_BYTES=0       # the backup copy keeps those bytes allocated
  if [ -n "$DB_BYTES" ] && [ -n "$AVAIL_BYTES" ]; then
    NEED_BYTES=$(( DB_BYTES * 12 / 10 + 1073741824 ))        # the whole database, +20 % and 1 GiB for WAL and temp files
    HAVE_BYTES=$(( AVAIL_BYTES + ${OLD_BYTES:-0} ))          # free now, plus what removing the old volume frees
    if [ "$HAVE_BYTES" -lt "$NEED_BYTES" ]; then
      err "Not enough space for the restore: the database is $(( DB_BYTES / 1048576 )) MiB, and on a cold-only"
      err "tiered install every month is restored onto pg_default (the named volume) before the tiering"
      err "job re-tiers the cold ones. The volume's filesystem has $(( HAVE_BYTES / 1048576 )) MiB (free plus the"
      err "old volume); about $(( NEED_BYTES / 1048576 )) MiB are needed. Free space, or set SKIP_SPACE_CHECK=1."
      err "The volume has NOT been modified."
      exit 1
    fi
    log "Space check: database $(( DB_BYTES / 1048576 )) MiB, room for the restore $(( HAVE_BYTES / 1048576 )) MiB."
  else
    warn "Could not measure the database size or the free space — skipping the space check."
  fi
fi

log "Dumping database '${DB_NAME}' → ${DUMP_FILE}"
# --no-tablespaces: meshinfo_cold does not exist in the fresh cluster, so the
# restore lands on pg_default and the tiering job re-tiers afterwards.
if ! docker exec -e PGPASSWORD="$DB_PASSWORD" "$TMP_PG" \
       pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges --no-tablespaces \
     | gzip > "$DUMP_FILE"; then
  err "pg_dump failed — the volume has NOT been modified."
  docker logs --tail 30 "$TMP_PG" >&2 || true
  exit 1
fi

# The dump is the recovery artifact: integrity-check it before anything destructive.
if [ ! -s "$DUMP_FILE" ] || ! gzip -t "$DUMP_FILE" 2>/dev/null; then
  err "Dump file is empty or corrupt — aborting before touching the volume."
  exit 1
fi
log "Dump complete and verified ($(du -h "$DUMP_FILE" | cut -f1))."

cleanup

# --- 3. Recreate the volume empty --------------------------------------------
if [ "${KEEP_VOLUME_BACKUP:-0}" = "1" ]; then
  BACKUP_VOLUME="${VOLUME}_oldpg_backup"
  log "Snapshotting old volume → '${BACKUP_VOLUME}'…"
  docker volume rm "$BACKUP_VOLUME" >/dev/null 2>&1 || true
  docker volume create "$BACKUP_VOLUME" >/dev/null
  docker run --rm -v "$VOLUME":/from:ro -v "$BACKUP_VOLUME":/to \
    alpine sh -c 'cp -a /from/. /to/'
fi

log "Removing the old volume so PostgreSQL ${NEW_VER} can initialise fresh…"
docker volume rm "$VOLUME" >/dev/null
# docker compose recreates the named volume on the next `up`.

# --- 4. Start the new version and restore ------------------------------------
log "Starting PostgreSQL ${NEW_VER}…"
docker compose up -d postgres

log "Waiting for PostgreSQL ${NEW_VER} to accept connections…"
for i in $(seq 1 60); do
  docker compose exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break
  if [ "$i" -eq 60 ]; then
    err "PostgreSQL ${NEW_VER} did not become ready."
    docker compose logs --tail 30 postgres >&2 || true
    exit 1
  fi
  sleep 1
done

log "Restoring the dump into PostgreSQL ${NEW_VER}…"
if ! gzip -dc "$DUMP_FILE" \
     | docker compose exec -T -e PGPASSWORD="$DB_PASSWORD" postgres \
         psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -q >/dev/null; then
  err "Restore failed. Your data is safe in: ${DUMP_FILE}"
  err "Investigate, then re-run the restore manually:"
  err "  gzip -dc '${DUMP_FILE}' | docker compose exec -T postgres psql -U ${DB_USER} -d ${DB_NAME}"
  exit 1
fi

log "Migration complete — PostgreSQL ${OLD_VER} → ${NEW_VER}. 🎉"
echo
echo "  SQL dump kept at : ${DUMP_FILE}"
[ "${KEEP_VOLUME_BACKUP:-0}" = "1" ] && echo "  Volume backup    : docker volume '${VOLUME}_oldpg_backup'"
if [ -n "$COLD_DIR" ]; then
  echo "  Cold tablespace  : the old cluster's copy of the cold months stays in ${COLD_DIR}/PG_${OLD_VER}_*;"
  echo "                     the tiering job re-tiers into PG_${NEW_VER}_* beside it, and the free-space"
  echo "                     guard counts the stale copy. Once the restore is verified (and the volume"
  echo "                     backup, if kept, is no longer needed):  sudo rm -rf ${COLD_DIR}/PG_${OLD_VER}_*"
fi
echo
echo "Start the full stack:  docker compose up -d"
