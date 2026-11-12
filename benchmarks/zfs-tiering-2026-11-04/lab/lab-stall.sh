#!/usr/bin/env bash
# Inside the lab container: the swap stall bound. The usual 6 readers + 2
# writers run for the whole move, plus a "slow" client that every SLOW_EVERY
# seconds holds ACCESS SHARE on mqtt_messages for several seconds (a payload
# ILIKE sequential scan over the cold month, SLOW_SCANS times inside one
# transaction) — the long in-flight query behind which the swap's ACCESS
# EXCLUSIVE request, and every other request on the parent, has to queue.
# Two configurations move all six months onto $COLD_TS and back:
#   new  the shipped constants (2.5 s lock timeout per attempt, 10 attempts, growing pauses)
#   old  the previous ones (20 s, 6 attempts, min(5, attempt) s pauses)
# api_max_ms of the ordinary requests is the stall an API user could see.
set -euo pipefail
DSN=postgresql://postgres@127.0.0.1:5432/meshinfo
REPO=${REPO:-/repo}
COLD_TS=${COLD_TS:-ts_zstd9}
SLOW_EVERY=${SLOW_EVERY:-12}
SLOW_SCANS=${SLOW_SCANS:-4}
cd /lab
python3 /lab/digests.py --dsn $DSN --from 2026-02 --to 2026-07 --json /lab/stall_digest_before.json
echo "[lab] wal_level: $(psql -h 127.0.0.1 -U postgres -d meshinfo -tAc 'show wal_level')"
# Prime: one move onto $COLD_TS, so that each leg's reset below is a real
# rebuild and both legs start from identical, just-rebuilt partitions
# (bytes_before, index density) whatever the CONFIGS order.
python3 $REPO/scripts/tier_partitions.py --dsn $DSN --tablespace $COLD_TS --cold-after-months 3 run --apply --all --json > /lab/stall_prime.json 2>/dev/null || true

for CFG in ${CONFIGS:-new old}; do
  rm -f /lab/stop
  if [ "$CFG" = old ]; then
    TIER="python3 /lab/tier_with_constants.py --swap-lock-timeout 20s --swap-attempts 6 --long-holder-seconds 5 --old-pauses -- --dsn $DSN"
  else
    TIER="python3 $REPO/scripts/tier_partitions.py --dsn $DSN"
  fi
  # every month starts on pg_default
  python3 $REPO/scripts/tier_partitions.py --dsn $DSN --tablespace pg_default run --apply --all --json > /lab/stall_${CFG}_reset.json 2>/dev/null || true
  python3 /lab/load_harness.py --dsn $DSN --seconds 1800 --readers 6 --writers 2 --cold-month 2026-06 \
    --slow-every $SLOW_EVERY --slow-scans $SLOW_SCANS --stop-file /lab/stop \
    --json /lab/stall_${CFG}_harness.json > /lab/stall_${CFG}_harness.log 2>&1 &
  HARNESS=$!
  sleep 15   # warm up; the first slow scan has run before the move starts

  START=$(date +%s.%N)
  $TIER --tablespace $COLD_TS --cold-after-months 3 run --apply --all --json \
    > /lab/stall_${CFG}_run.json 2> /lab/stall_${CFG}_run.log || echo "[$CFG] tier exit $?"
  END=$(date +%s.%N)
  echo "[$CFG] tier run wall seconds: $(python3 -c "print(round($END-$START,1))")"
  sleep 5
  touch /lab/stop
  wait $HARNESS || true

  python3 - <<PY
import json
d = json.load(open('/lab/stall_${CFG}_run.json'))
print('[$CFG] moved', d['moved'], 'busy', d['busy'], 'failed', d['failed'], 'refused', d['refused'])
for r in d['results']:
    print('   ', r['partition'], r['status'], round(r['seconds'], 1), 's, swap attempts', r.get('swap_attempts'))
h = json.load(open('/lab/stall_${CFG}_harness.json'))
print('[$CFG] api requests: ok', h['api_ok'], 'errors', h['total_errors'], 'p50', h['api_p50_ms'], 'p99', h['api_p99_ms'],
      'MAX', h['api_max_ms'], 'ms; over 1 s:', h['api_over_1s'], 'over 3 s:', h['api_over_3s'])
print('[$CFG] slow client:', h['ops'].get('slow'))
print('[$CFG] slowest ordinary requests (s since start, op, ms):', h['slowest'][:10])
PY
  echo "[$CFG] swap log lines: $(grep -c -E 'postponed|given up|hit lock_timeout|hit statement_timeout|hit deadlock' /lab/stall_${CFG}_run.log || true)"
  grep -E 'postponed|given up|hit lock_timeout|hit statement_timeout|hit deadlock|busy' /lab/stall_${CFG}_run.log | head -30 || true
  python3 /lab/digests.py --dsn $DSN --from 2026-02 --to 2026-07 --json /lab/stall_${CFG}_digest_after.json
  python3 - <<PY
import json
a = json.load(open('/lab/stall_digest_before.json')); b = json.load(open('/lab/stall_${CFG}_digest_after.json'))
bad = [k for k in a if a[k] != b[k]]
print('[$CFG] digest check:', 'IDENTICAL' if not bad else 'MISMATCH ' + str(bad))
PY
done

python3 $REPO/scripts/tier_partitions.py --dsn $DSN --tablespace pg_default run --apply --all --json > /lab/stall_final_back.json 2>/dev/null || true
python3 -c "import json; d=json.load(open('/lab/stall_final_back.json')); print('moved back:', d['moved'], 'busy', d['busy'], 'failed', d['failed'])"
echo STALL_DONE
