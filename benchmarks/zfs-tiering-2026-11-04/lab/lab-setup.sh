#!/usr/bin/env bash
# Runs INSIDE the privileged lab container (meshinfo-tiering-lab image).
# Creates loop-mounted filesystems, a PostgreSQL 18 cluster on ext4, applies the
# MeshInfo schema (dumped from a cluster initialised by the real ensure_schema),
# and one tablespace per compressed mount.
set -euo pipefail

IMG=/lab/img
mkdir -p "$IMG" /mnt/ext4 /mnt/zstd3 /mnt/zstd9 /mnt/lzo
grep -q btrfs /proc/filesystems || { echo "btrfs not available in this kernel"; exit 1; }

mkimg() { # name size
  [ -f "$IMG/$1.img" ] || truncate -s "$2" "$IMG/$1.img"
}
mkimg ext4 80G; mkimg zstd3 40G; mkimg zstd9 40G; mkimg lzo 40G

if ! mountpoint -q /mnt/ext4; then
  blkid "$IMG/ext4.img" >/dev/null 2>&1 || mkfs.ext4 -q -F "$IMG/ext4.img"
  mount -o loop,noatime "$IMG/ext4.img" /mnt/ext4
fi
for fs in zstd3 zstd9 lzo; do
  if ! mountpoint -q /mnt/$fs; then
    blkid "$IMG/$fs.img" >/dev/null 2>&1 || mkfs.btrfs -q -f "$IMG/$fs.img"
    case $fs in
      zstd3) opt=compress-force=zstd:3 ;;
      zstd9) opt=compress-force=zstd:9 ;;
      lzo)   opt=compress-force=lzo ;;
    esac
    mount -o loop,noatime,$opt "$IMG/$fs.img" /mnt/$fs
  fi
done
grep -E "/mnt/(ext4|zstd3|zstd9|lzo)" /proc/mounts

PGDATA=/mnt/ext4/pgdata
export PGDATA
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"
  su postgres -c "/usr/lib/postgresql/18/bin/initdb -D $PGDATA --auth=trust -E UTF8 --locale=C.UTF-8 >/lab/initdb.log 2>&1"
  cat >> "$PGDATA/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
port = 5432
shared_buffers = 1GB
work_mem = 16MB
maintenance_work_mem = 256MB
effective_cache_size = 3GB
max_wal_size = 8GB
checkpoint_timeout = 15min
max_locks_per_transaction = 256
log_min_duration_statement = 2000
log_lock_waits = on
log_line_prefix = '%m [%p] '
wal_level = minimal
max_wal_senders = 0
CONF
fi
for fs in zstd3 zstd9 lzo; do
  mkdir -p /mnt/$fs/ts && chown postgres:postgres /mnt/$fs/ts && chmod 700 /mnt/$fs/ts
done
mkdir -p /mnt/ext4/ts && chown postgres:postgres /mnt/ext4/ts && chmod 700 /mnt/ext4/ts

if ! su postgres -c "/usr/lib/postgresql/18/bin/pg_ctl -D $PGDATA status" >/dev/null 2>&1; then
  su postgres -c "/usr/lib/postgresql/18/bin/pg_ctl -D $PGDATA -l /lab/pg.log -w start"
fi
PSQL="psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q"
if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='meshinfo'" | grep -q 1; then
  $PSQL -c "CREATE DATABASE meshinfo"
  $PSQL -d meshinfo -f /lab/schema_full.sql >/lab/schema.log 2>&1
fi
for fs in zstd3 zstd9 lzo ext4; do
  $PSQL -d meshinfo -tAc "SELECT 1 FROM pg_tablespace WHERE spcname='ts_$fs'" | grep -q 1 || \
    $PSQL -d meshinfo -c "CREATE TABLESPACE ts_$fs LOCATION '/mnt/$fs/ts'"
done
$PSQL -d meshinfo -c "\db"
$PSQL -d meshinfo -tAc "SELECT count(*) FROM pg_inherits WHERE inhparent='mqtt_messages'::regclass"
echo "LAB READY: PGDATA=$PGDATA"
