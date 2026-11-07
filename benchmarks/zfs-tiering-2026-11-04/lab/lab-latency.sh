#!/usr/bin/env bash
# Inside the lab container: cold/warm latency of representative queries with the
# archive on ext4, then on btrfs zstd:3, then on btrfs zstd:9 (moved with the
# real tiering CLI), then moved back to pg_default (acceptance: --tablespace
# pg_default), with whole-row digests checked after every move.
set -euo pipefail
DSN=postgresql://postgres@127.0.0.1:5432/meshinfo
PGDATA=/mnt/ext4/pgdata
PSQL="psql -h 127.0.0.1 -U postgres -d meshinfo -v ON_ERROR_STOP=1 -X -q"
REPO=${REPO:-/repo}
TIER="python3 $REPO/scripts/tier_partitions.py --dsn $DSN"
cd /lab

python3 /lab/digests.py --dsn $DSN --from 2026-02 --to 2026-07 --json /lab/digest_ext4.json

python3 /lab/bench_queries.py --dsn $DSN --pgdata $PGDATA --month 2026-06 --label ext4 --json /lab/latency_ext4.json

for ts in zstd3 zstd9; do
  echo "== tiering every closed month to ts_$ts"
  /usr/bin/time -f "tier to ts_$ts: %e s" $TIER --tablespace ts_$ts --cold-after-months 1 run --apply --all --json > /lab/tier_to_$ts.json
  python3 -c "import json; d=json.load(open('/lab/tier_to_$ts.json')); print('moved', d['moved'], 'refused', d['refused'], 'busy', d['busy'], 'failed', d['failed']); [print(' ', r['partition'], r['status'], r['rows'], r['bytes_before'], '->', r['bytes_after'], r['seconds'], 's') for r in d['results']]"
  $PSQL -c "CHECKPOINT"
  python3 /lab/digests.py --dsn $DSN --from 2026-02 --to 2026-07 --json /lab/digest_$ts.json
  python3 - <<PY
import json
a = json.load(open('/lab/digest_ext4.json')); b = json.load(open('/lab/digest_$ts.json'))
bad = [k for k in a if a[k] != b[k]]
print('digest check after move to $ts:', 'IDENTICAL' if not bad else ('MISMATCH ' + str(bad)))
PY
  sync
  echo "== compsize of ts_$ts after CHECKPOINT"
  compsize -b /mnt/$ts/ts | tee /lab/compsize_ts_$ts.txt
  python3 /lab/bench_queries.py --dsn $DSN --pgdata $PGDATA --month 2026-06 --label $ts --json /lab/latency_$ts.json
done

echo "== moving every month back to pg_default"
/usr/bin/time -f "tier back to pg_default: %e s" $TIER --tablespace pg_default run --apply --all --json > /lab/tier_back_1.json
python3 -c "import json; d=json.load(open('/lab/tier_back_1.json')); print('moved', d['moved'], 'refused', d['refused'], 'busy', d['busy'], 'failed', d['failed'])"
python3 /lab/digests.py --dsn $DSN --from 2026-02 --to 2026-07 --json /lab/digest_back_1.json
python3 - <<PY
import json
a = json.load(open('/lab/digest_ext4.json')); b = json.load(open('/lab/digest_back_1.json'))
bad = [k for k in a if a[k] != b[k]]
print('digest check after move back:', 'IDENTICAL' if not bad else ('MISMATCH ' + str(bad)))
PY
$TIER status | tail -20
echo LATENCY_DONE
