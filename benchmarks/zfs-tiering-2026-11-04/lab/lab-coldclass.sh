#!/usr/bin/env bash
# Inside the lab container: per-class compressed size of the REBUILT relations
# on the cold tablespace (relfilenodes change on rebuild, so the catalog is
# re-dumped after the move), then everything back to pg_default.
set -euo pipefail
DSN=postgresql://postgres@127.0.0.1:5432/meshinfo
PSQL="psql -h 127.0.0.1 -U postgres -d meshinfo -v ON_ERROR_STOP=1 -X -q"
REPO=${REPO:-/repo}
TIER="python3 $REPO/scripts/tier_partitions.py --dsn $DSN"
COLD_TS=${COLD_TS:-ts_zstd9}
FS=${COLD_TS#ts_}
cd /lab

/usr/bin/time -f "tier to $COLD_TS: %e s" $TIER --tablespace $COLD_TS --cold-after-months 1 run --apply --all --json > /lab/coldclass_run.json
python3 -c "import json; d=json.load(open('/lab/coldclass_run.json')); print('moved', d['moved'], 'refused', d['refused'], 'busy', d['busy'], 'failed', d['failed'])"
$PSQL -c "CHECKPOINT"; sync
python3 $REPO/scripts/zfs_estimate.py dump-catalog --dsn $DSN --out /lab/catalog_after.json
DBID=$($PSQL -tAc "SELECT oid FROM pg_database WHERE datname='meshinfo'")
ROOT=$(ls -d /mnt/$FS/ts/PG_*/$DBID)
echo "cold root: $ROOT"
python3 /lab/compsize_by_class.py --catalog /lab/catalog_after.json --root "$ROOT" --label "rebuilt-on-$FS" --json /lab/compsize_rebuilt_$FS.json
$PSQL -tAc "SELECT 'rebuilt index bytes: ' || sum(pg_indexes_size(c.oid)) || ', heap bytes: ' || sum(pg_table_size(c.oid)) FROM pg_class c JOIN pg_tablespace t ON t.oid=c.reltablespace WHERE t.spcname='$COLD_TS' AND c.relkind='r'"
/usr/bin/time -f "tier back: %e s" $TIER --tablespace pg_default run --apply --all --json > /lab/coldclass_back.json
python3 -c "import json; d=json.load(open('/lab/coldclass_back.json')); print('back: moved', d['moved'], 'refused', d['refused'], 'busy', d['busy'], 'failed', d['failed'])"
echo COLDCLASS_DONE
