#!/usr/bin/env bash
# Inside the lab container: inventory + catalog, then real on-disk sizes of the
# database files on each compressing filesystem (compsize), per relation class.
set -euo pipefail
DSN=postgresql://postgres@127.0.0.1:5432/meshinfo
PSQL="psql -h 127.0.0.1 -U postgres -d meshinfo -v ON_ERROR_STOP=1 -X -q"
PGDATA=/mnt/ext4/pgdata
PGCTL="/usr/lib/postgresql/18/bin/pg_ctl -D $PGDATA"
cd /lab

$PSQL -c "CHECKPOINT"
DBID=$($PSQL -tAc "SELECT oid FROM pg_database WHERE datname='meshinfo'")
echo "dbid=$DBID"
$PSQL -tAc "SELECT json_build_object(
  'database_bytes', pg_database_size('meshinfo'),
  'relations', (SELECT json_agg(row_to_json(t)) FROM (
     SELECT c.relname, c.relkind::text AS relkind, am.amname, COALESCE(ts.spcname, 'pg_default') AS tablespace,
            pg_relation_size(c.oid) AS main_bytes, pg_table_size(c.oid) AS table_bytes,
            pg_indexes_size(c.oid) AS index_bytes, pg_total_relation_size(c.oid) AS total_bytes,
            c.reltuples::bigint AS reltuples
     FROM pg_class c LEFT JOIN pg_am am ON am.oid = c.relam LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','i') AND pg_total_relation_size(c.oid) >= 1048576
     ORDER BY c.relname) t),
  'per_table', (SELECT json_agg(row_to_json(u)) FROM (
     SELECT parent, sum(main_bytes) AS heap_bytes, sum(index_bytes) AS index_bytes, sum(total_bytes) AS total_bytes, sum(n) AS rows
     FROM (SELECT i.inhparent::regclass::text AS parent, pg_relation_size(c.oid) AS main_bytes, pg_indexes_size(c.oid) AS index_bytes,
                  pg_total_relation_size(c.oid) AS total_bytes, c.reltuples::bigint AS n
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent IN ('mqtt_messages'::regclass, 'packet_receptions'::regclass)) x GROUP BY parent) u)
)" > /lab/inventory.json
python3 -c "import json; d=json.load(open('/lab/inventory.json')); print('db bytes', d['database_bytes']); [print(t) for t in d['per_table']]"

python3 /repo/scripts/zfs_estimate.py dump-catalog --dsn $DSN --out /lab/catalog.json
python3 -c "import json; d=json.load(open('/lab/catalog.json')); print('catalog entries', len(d))"

su postgres -c "$PGCTL -w -m fast stop"
echo "ext4 base/$DBID bytes: $(du -sb $PGDATA/base/$DBID | cut -f1)"
echo "ext4 cluster bytes: $(du -sb $PGDATA | cut -f1)"
for fs in zstd3 zstd9 lzo; do
  rm -rf /mnt/$fs/copy; mkdir -p /mnt/$fs/copy
  /usr/bin/time -f "$fs copy %e s" cp -a $PGDATA/base/$DBID /mnt/$fs/copy/
  sync
  echo "== compsize whole copy on $fs"
  compsize -b /mnt/$fs/copy | tee /lab/compsize_${fs}_whole.txt
  python3 /lab/compsize_by_class.py --catalog /lab/catalog.json --root /mnt/$fs/copy/$DBID --label $fs --json /lab/compsize_$fs.json
done
su postgres -c "$PGCTL -w -l /lab/pg.log start"
$PSQL -tAc "SELECT 'pg back: ' || count(*) || ' partitions' FROM pg_inherits WHERE inhparent='mqtt_messages'::regclass"
echo SIZES_DONE
