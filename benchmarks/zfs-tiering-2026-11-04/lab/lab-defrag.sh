#!/usr/bin/env bash
# Inside the lab container: move the archive onto the btrfs zstd:9 tablespace
# while the reader/writer harness runs (the fragmenting case), measure the
# tablespace after a CHECKPOINT, then `btrfs filesystem defragment` it and
# measure again — separates data compressibility from extent layout. ZFS has
# fixed-size records, so it does not fragment this way in the first place.
set -euo pipefail
DSN=postgresql://postgres@127.0.0.1:5432/meshinfo
PSQL="psql -h 127.0.0.1 -U postgres -d meshinfo -v ON_ERROR_STOP=1 -X -q"
REPO=${REPO:-/repo}
TIER="python3 $REPO/scripts/tier_partitions.py --dsn $DSN"
cd /lab
rm -f /lab/stop
python3 /lab/load_harness.py --dsn $DSN --seconds 1800 --readers 6 --writers 2 --cold-month 2026-06 \
  --stop-file /lab/stop --json /lab/defrag_harness.json > /lab/defrag_harness.log 2>&1 &
HARNESS=$!
sleep 8
/usr/bin/time -f "tier under load: %e s" $TIER --tablespace ts_zstd9 --cold-after-months 3 run --apply --all --json > /lab/defrag_run.json
touch /lab/stop; wait $HARNESS || true
python3 -c "import json; d=json.load(open('/lab/defrag_harness.json')); print('harness: ok', d['total_ok'], 'errors', d['total_errors'], 'p99', d['all_p99_ms'], 'max', d['all_max_ms'])"
$PSQL -c "CHECKPOINT"; sync
echo "== fragmented (after a loaded move)"; compsize -b /mnt/zstd9/ts | tee /lab/defrag_before.txt
/usr/bin/time -f "defragment: %e s" btrfs filesystem defragment -r -czstd /mnt/zstd9/ts
sync; sleep 3; sync
echo "== after btrfs filesystem defragment -czstd"; compsize -b /mnt/zstd9/ts | tee /lab/defrag_after.txt
python3 /lab/digests.py --dsn $DSN --from 2026-02 --to 2026-07 --json /lab/defrag_digest.json > /dev/null
python3 - <<PY
import json
a = json.load(open('/lab/e2e_digest_before.json')); b = json.load(open('/lab/defrag_digest.json'))
bad = [k for k in a if a[k] != b[k]]
print('digest check after defragment:', 'IDENTICAL' if not bad else ('MISMATCH ' + str(bad)))
PY
/usr/bin/time -f "tier back: %e s" $TIER --tablespace pg_default run --apply --all --json > /lab/defrag_back.json
echo DEFRAG_DONE
