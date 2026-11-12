#!/usr/bin/env bash
# Inside the lab container: end-to-end tiering run with a concurrent reader +
# writer loop. Digests before/after, harness error count must be 0, plan must
# be empty afterwards, cold tablespace measured only after CHECKPOINT, then
# everything moved back with --tablespace pg_default.
set -euo pipefail
DSN=postgresql://postgres@127.0.0.1:5432/meshinfo
PSQL="psql -h 127.0.0.1 -U postgres -d meshinfo -v ON_ERROR_STOP=1 -X -q"
REPO=${REPO:-/repo}
TIER="python3 $REPO/scripts/tier_partitions.py --dsn $DSN"
COLD_TS=${COLD_TS:-ts_zstd9}
cd /lab
rm -f /lab/stop

$TIER status > /lab/e2e_status_before.txt
python3 /lab/digests.py --dsn $DSN --from 2026-02 --to 2026-07 --json /lab/e2e_digest_before.json
$TIER --tablespace $COLD_TS --cold-after-months 3 plan --all --json > /lab/e2e_plan_before.json
python3 -c "import json; print('plan before:', len(json.load(open('/lab/e2e_plan_before.json'))), 'items')"

python3 /lab/load_harness.py --dsn $DSN --seconds 1800 --readers 6 --writers 2 --cold-month 2026-06 \
  --stop-file /lab/stop --json /lab/e2e_harness.json > /lab/e2e_harness.log 2>&1 &
HARNESS=$!
sleep 8   # let the harness warm up before the move starts

START=$(date +%s.%N)
$TIER --tablespace $COLD_TS --cold-after-months 3 run --apply --all --deep-verify --json > /lab/e2e_run.json || echo "tier exit $?"
END=$(date +%s.%N)
echo "tier run wall seconds: $(python3 -c "print(round($END-$START,1))")"
sleep 5
touch /lab/stop
wait $HARNESS || true
python3 -c "import json; d=json.load(open('/lab/e2e_run.json')); print('moved', d['moved'], 'refused', d['refused'], 'busy', d['busy'], 'failed', d['failed']); [print(' ', r['partition'], r['status'], r['rows'], r['bytes_before'], '->', r['bytes_after'], r['seconds'], 's', 'swap', r.get('swap_attempts')) for r in d['results']]"
python3 -c "import json; d=json.load(open('/lab/e2e_harness.json')); print('harness: ok', d['total_ok'], 'errors', d['total_errors'], 'p50', d['all_p50_ms'], 'p99', d['all_p99_ms'], 'max', d['all_max_ms']); [print('  ', k, v) for k, v in d['ops'].items()]; print('  error samples:', d['error_samples'][:5])"

python3 /lab/digests.py --dsn $DSN --from 2026-02 --to 2026-07 --json /lab/e2e_digest_after.json
python3 - <<PY
import json
a = json.load(open('/lab/e2e_digest_before.json')); b = json.load(open('/lab/e2e_digest_after.json'))
bad = [k for k in a if a[k] != b[k]]
print('digest check after e2e move:', 'IDENTICAL' if not bad else ('MISMATCH ' + str(bad)))
PY
$TIER --tablespace $COLD_TS --cold-after-months 3 plan --all --json > /lab/e2e_plan_after.json
python3 -c "import json; n=len(json.load(open('/lab/e2e_plan_after.json'))); print('plan after:', n, 'items', '(OK: nothing left)' if n==0 else '(UNEXPECTED)')"
$TIER status > /lab/e2e_status_after.txt; cat /lab/e2e_status_after.txt | tail -20
$TIER --json status > /lab/e2e_status_after.json

$PSQL -c "CHECKPOINT"; sync
echo "== cold tablespace on $COLD_TS after CHECKPOINT"
compsize -b /mnt/${COLD_TS#ts_}/ts | tee /lab/e2e_compsize_cold.txt
$PSQL -tAc "SELECT 'cold tablespace logical bytes (pg): ' || sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_tablespace t ON t.oid=c.reltablespace WHERE t.spcname='$COLD_TS' AND c.relkind IN ('r','i','t')"

echo "== moving everything back to pg_default (acceptance)"
/usr/bin/time -f "tier back: %e s" $TIER --tablespace pg_default run --apply --all --deep-verify --json > /lab/e2e_back.json
python3 -c "import json; d=json.load(open('/lab/e2e_back.json')); print('back: moved', d['moved'], 'refused', d['refused'], 'busy', d['busy'], 'failed', d['failed'])"
python3 /lab/digests.py --dsn $DSN --from 2026-02 --to 2026-07 --json /lab/e2e_digest_back.json
python3 - <<PY
import json
a = json.load(open('/lab/e2e_digest_before.json')); b = json.load(open('/lab/e2e_digest_back.json'))
bad = [k for k in a if a[k] != b[k]]
print('digest check after move back:', 'IDENTICAL' if not bad else ('MISMATCH ' + str(bad)))
PY
$PSQL -tAc "SELECT 'scratch objects: ' || count(*) FROM pg_class WHERE relname LIKE '%\_tiering%'"
echo E2E_DONE
