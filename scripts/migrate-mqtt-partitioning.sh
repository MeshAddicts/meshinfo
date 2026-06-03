#!/usr/bin/env bash
#
# migrate-mqtt-partitioning.sh — convert the mqtt_messages table to a
# month-partitioned table, in place, on an existing MeshInfo database.
#
# Fresh installs are already partitioned (postgres/sql/schema.sql). This script
# is the one-time conversion for databases created before partitioning landed.
#
# What it does, inside a SINGLE atomic transaction (so any failure rolls the
# whole thing back and leaves mqtt_messages exactly as it was):
#
#   1. Renames the existing table to mqtt_messages_old.
#   2. Creates a new mqtt_messages partitioned by month on created_at.
#   3. Creates one partition per month the data spans, copies every row,
#      and verifies the row count matches before committing.
#   4. Rebuilds the indexes, re-homes the id sequence, reinstalls the trigger.
#
# The original data is KEPT as mqtt_messages_old — your rollback. Disk is not
# reclaimed until you drop it (the script prints the command).
#
# Run it once, with the stack already up:
#
#   bash scripts/migrate-mqtt-partitioning.sh
#
# For a dev stack:  COMPOSE_FILE=docker-compose-dev.yml bash scripts/migrate-mqtt-partitioning.sh
# On Windows, run it from Git Bash.
#
# Environment overrides:
#   COMPOSE_FILE                compose file to use (default: docker-compose.yml)
#   POSTGRES_DB/USER/PASSWORD   database credentials (defaults: meshinfo/postgres/password)
#
set -euo pipefail

# Stop MSYS/Git-Bash (Windows) from rewriting container-style paths.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

DB_NAME="${POSTGRES_DB:-meshinfo}"
DB_USER="${POSTGRES_USER:-postgres}"
DB_PASSWORD="${POSTGRES_PASSWORD:-password}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }
human() { numfmt --to=iec "$1" 2>/dev/null || echo "${1} bytes"; }

cd "$REPO_ROOT"

# --- Pre-flight --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { err "docker not found on PATH"; exit 1; }
docker compose version >/dev/null 2>&1 || {
  err "docker compose (v2) is required — install the Compose plugin or upgrade Docker."
  exit 1
}

psql_q() {
  docker compose exec -T -e PGPASSWORD="$DB_PASSWORD" postgres \
    psql -tAqX -U "$DB_USER" -d "$DB_NAME" -c "$1"
}

log "Checking the postgres service…"
docker compose exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 || {
  err "The postgres service is not running/ready. Start it first:  docker compose up -d postgres"
  exit 1
}

RELKIND="$(psql_q "SELECT relkind FROM pg_class WHERE relname='mqtt_messages' AND relnamespace='public'::regnamespace" | tr -d '[:space:]')"
case "$RELKIND" in
  "") log "No mqtt_messages table found — fresh install, nothing to migrate."; exit 0 ;;
  p)  log "mqtt_messages is already partitioned — migration not needed."; exit 0 ;;
  r)  : ;;  # regular table — proceed
  *)  err "Unexpected relkind '$RELKIND' for mqtt_messages — aborting."; exit 1 ;;
esac

# --- Disk pre-flight ---------------------------------------------------------
# The migration transiently needs the new table + WAL + headroom alongside the
# original. Require ~3x the current table size free on the data volume.
TABLE_BYTES="$(psql_q "SELECT pg_total_relation_size('mqtt_messages')" | tr -d '[:space:]')"
FREE_BYTES="$(docker compose exec -T postgres sh -c \
  "df -P -B1 /var/lib/postgresql | tail -1 | awk '{print \$4}'" | tr -d '[:space:]')"
NEED_BYTES=$(( TABLE_BYTES * 3 ))

log "mqtt_messages size: $(human "$TABLE_BYTES")  |  free on data volume: $(human "$FREE_BYTES")"
if [ "${FREE_BYTES:-0}" -lt "$NEED_BYTES" ]; then
  err "Not enough free disk. This migration needs ~3x the table size"
  err "(about $(human "$NEED_BYTES")) free transiently. Expand the data volume and retry."
  exit 1
fi

ROWS_BEFORE="$(psql_q "SELECT count(*) FROM mqtt_messages" | tr -d '[:space:]')"
log "Migrating mqtt_messages — ${ROWS_BEFORE} rows. This can take several minutes."

# --- Stop the app so nothing writes mid-migration ----------------------------
log "Stopping the meshinfo container…"
docker compose stop meshinfo >/dev/null 2>&1 || true

# --- Run the migration (one atomic transaction) ------------------------------
log "Running the partitioning migration (atomic — rolls back fully on any error)…"
if ! docker compose exec -T -e PGPASSWORD="$DB_PASSWORD" postgres \
       psql --single-transaction -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -q <<'SQL'
-- 1. Move the existing table + its objects aside (frees the canonical names).
ALTER TABLE mqtt_messages RENAME TO mqtt_messages_old;
DROP TRIGGER IF EXISTS trg_mqtt_messages_extract_node_ids ON mqtt_messages_old;
ALTER TABLE mqtt_messages_old DROP CONSTRAINT IF EXISTS mqtt_messages_pkey;
DROP INDEX IF EXISTS idx_mqtt_messages_created_at;
DROP INDEX IF EXISTS idx_mqtt_messages_timestamp;
DROP INDEX IF EXISTS idx_mqtt_messages_from_node_id;
DROP INDEX IF EXISTS idx_mqtt_messages_to_node_id;
DROP INDEX IF EXISTS idx_mqtt_messages_backfill;

-- 2. New month-partitioned table (same columns; payload lz4-compressed).
CREATE TABLE mqtt_messages (
    id           BIGINT NOT NULL,
    topic        TEXT,
    payload      TEXT COMPRESSION lz4,
    qos          INTEGER,
    retain       BOOLEAN,
    timestamp    BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    from_node_id VARCHAR(8),
    to_node_id   VARCHAR(8),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 3. One partition per calendar month the data spans (+ 2 months ahead),
--    plus a DEFAULT catch-all.
DO $mig$
DECLARE
    m  date := date_trunc('month',
                  COALESCE((SELECT min(created_at) FROM mqtt_messages_old), now()))::date;
    hi date := date_trunc('month', now() + interval '2 months')::date;
BEGIN
    WHILE m <= hi LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF mqtt_messages '
            'FOR VALUES FROM (%L) TO (%L)',
            'mqtt_messages_' || to_char(m, 'YYYY_MM'),
            m, (m + interval '1 month')::date);
        m := (m + interval '1 month')::date;
    END LOOP;
END $mig$;
CREATE TABLE IF NOT EXISTS mqtt_messages_default PARTITION OF mqtt_messages DEFAULT;

-- 4. Copy every row (routed into the monthly partitions).
INSERT INTO mqtt_messages
    (id, topic, payload, qos, retain, timestamp, created_at, from_node_id, to_node_id)
SELECT id, topic, payload, qos, retain, timestamp,
       COALESCE(created_at, now()), from_node_id, to_node_id
FROM mqtt_messages_old;

-- 5. Fail loudly (rolls the whole transaction back) if any row was lost.
DO $check$
DECLARE
    n_old bigint;
    n_new bigint;
BEGIN
    SELECT count(*) INTO n_old FROM mqtt_messages_old;
    SELECT count(*) INTO n_new FROM mqtt_messages;
    IF n_old <> n_new THEN
        RAISE EXCEPTION 'Row count mismatch (old=%, new=%) — rolling back.', n_old, n_new;
    END IF;
    RAISE NOTICE 'Verified: % rows migrated into partitioned mqtt_messages.', n_new;
END $check$;

-- 6. Indexes (built after the bulk load).
CREATE INDEX idx_mqtt_messages_created_at   ON mqtt_messages (created_at DESC);
CREATE INDEX idx_mqtt_messages_timestamp    ON mqtt_messages ("timestamp" DESC);
CREATE INDEX idx_mqtt_messages_from_node_id ON mqtt_messages (from_node_id, created_at DESC);
CREATE INDEX idx_mqtt_messages_to_node_id   ON mqtt_messages (to_node_id, created_at DESC);
CREATE INDEX idx_mqtt_messages_backfill     ON mqtt_messages (id) WHERE from_node_id IS NULL;

-- 7. Re-home the id sequence onto the new table and advance it past max(id).
ALTER SEQUENCE mqtt_messages_id_seq OWNED BY mqtt_messages.id;
ALTER TABLE mqtt_messages ALTER COLUMN id SET DEFAULT nextval('mqtt_messages_id_seq');
SELECT setval('mqtt_messages_id_seq', GREATEST((SELECT COALESCE(max(id), 1) FROM mqtt_messages), 1));

-- 8. Reinstall the BEFORE INSERT node-id extraction trigger (cascades to partitions).
DROP TRIGGER IF EXISTS trg_mqtt_messages_extract_node_ids ON mqtt_messages;
CREATE TRIGGER trg_mqtt_messages_extract_node_ids
    BEFORE INSERT ON mqtt_messages
    FOR EACH ROW EXECUTE FUNCTION mqtt_messages_extract_node_ids();

-- 9. Refresh planner statistics for the freshly-loaded table.
ANALYZE mqtt_messages;
SQL
then
  err "Migration failed — the transaction rolled back; mqtt_messages is unchanged."
  err "Bring the app back up with:  docker compose up -d"
  exit 1
fi

# --- Done --------------------------------------------------------------------
log "Restarting the meshinfo container…"
docker compose up -d meshinfo >/dev/null

log "Partitioning migration complete. 🎉"
echo
echo "  mqtt_messages is now partitioned by month."
echo "  The original data is kept as table 'mqtt_messages_old' — your rollback."
echo "  Disk is not reclaimed until you drop it. Once you've confirmed the app"
echo "  and the Logs page look right, run:"
echo
echo "    docker compose exec postgres psql -U ${DB_USER} -d ${DB_NAME} \\"
echo "      -c 'DROP TABLE mqtt_messages_old;'"
echo
