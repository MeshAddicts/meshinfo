#!/usr/bin/env python3
"""Representative query latency, cold (page cache + shared buffers dropped by a
PostgreSQL restart and /proc/sys/vm/drop_caches) vs warm (same query repeated).

    python3 bench_queries.py --dsn ... --pgdata /mnt/ext4/pgdata --month 2026-06 --label ext4 --json out.json

Runs as root inside the lab container (needs drop_caches + pg_ctl via su postgres).
"""
import argparse
import asyncio
import datetime
import json
import statistics
import subprocess
import time

import asyncpg

RECEPTION_COUNT_SQL = (
    "(SELECT count(*) FROM packet_receptions pr WHERE pr.mqtt_row_id = mqtt_messages.id "
    "AND pr.created_at >= mqtt_messages.created_at "
    "AND pr.created_at < mqtt_messages.created_at + interval '86400 seconds')"
)
PAGE = (f"SELECT id, topic, payload, qos, retain, timestamp, created_at, {RECEPTION_COUNT_SQL} AS reception_count "
        "FROM mqtt_messages {where} ORDER BY created_at DESC, id DESC LIMIT 101")


def restart_and_drop(pgdata):
    subprocess.run(["su", "postgres", "-c", f"/usr/lib/postgresql/18/bin/pg_ctl -D {pgdata} -w -m fast restart "
                                            f"-l /lab/pg.log"], check=True, capture_output=True)
    subprocess.run(["sync"], check=True)
    with open("/proc/sys/vm/drop_caches", "w") as f:
        f.write("3\n")
    time.sleep(1.0)


async def run_once(dsn, sql, args):
    conn = await asyncpg.connect(dsn, command_timeout=600)
    try:
        t0 = time.perf_counter()
        rows = await conn.fetch(sql, *args)
        return time.perf_counter() - t0, len(rows)
    finally:
        await conn.close()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--pgdata", required=True)
    ap.add_argument("--month", default="2026-06")
    ap.add_argument("--label", default="")
    ap.add_argument("--warm-runs", type=int, default=5)
    ap.add_argument("--json", default="")
    a = ap.parse_args()
    y, m = int(a.month[:4]), int(a.month[5:7])
    lo = datetime.datetime(y, m, 1, tzinfo=datetime.timezone.utc)
    hi = datetime.datetime(y + (m // 12), m % 12 + 1, 1, tzinfo=datetime.timezone.utc)
    mid = lo + datetime.timedelta(days=14)
    conn = await asyncpg.connect(a.dsn)
    node = await conn.fetchval(
        "SELECT from_node_id FROM mqtt_messages WHERE created_at >= $1 AND created_at < $2 AND from_node_id IS NOT NULL "
        "GROUP BY from_node_id ORDER BY count(*) DESC OFFSET 20 LIMIT 1", lo, hi)
    rid = await conn.fetchval("SELECT id FROM mqtt_messages WHERE created_at >= $1 AND created_at < $2 OFFSET 12345 LIMIT 1",
                              mid, hi)
    rid_created = await conn.fetchval("SELECT created_at FROM mqtt_messages WHERE id = $1", rid)
    await conn.close()
    queries = {
        "month_page_latest": (PAGE.format(where="WHERE created_at >= $1 AND created_at <= $2"), [lo, hi]),
        "month_page_cursor": (PAGE.format(where="WHERE created_at >= $1 AND created_at <= $2 AND (created_at, id) < ($3, $4)"),
                              [lo, hi, mid, rid]),
        "node_page": (PAGE.format(where="WHERE (from_node_id = $1 OR to_node_id = $1) AND created_at >= $2 AND created_at <= $3"),
                      [node, lo, hi]),
        "topic_trgm_page": (PAGE.format(where="WHERE topic ILIKE '%' || $1 || '%' ESCAPE '\\' AND created_at >= $2 AND created_at <= $3"),
                            ["MediumFast", lo, hi]),
        "payload_search_3d": (PAGE.format(where="WHERE payload ILIKE '%' || $1 || '%' AND created_at >= $2 AND created_at <= $3"),
                              ["NODEINFO_APP", mid, mid + datetime.timedelta(days=3)]),
        "permalink_receptions": (
            "SELECT pr.gateway, t.topic, pr.rx_rssi, pr.rx_snr, pr.rx_time, pr.hop_limit, pr.hops_away, pr.relay_node, "
            "pr.transport, pr.extras, pr.created_at FROM packet_receptions pr LEFT JOIN mqtt_topics t ON t.id = pr.topic_id "
            "WHERE pr.mqtt_row_id = $1 AND pr.created_at >= $2 AND pr.created_at < $2 + interval '86400 seconds' "
            "ORDER BY pr.created_at, pr.gateway", [rid, rid_created]),
        "gateway_day_count": ("SELECT count(*) FROM packet_receptions WHERE gateway = (SELECT gateway FROM packet_receptions "
                              "WHERE created_at >= $1 AND created_at < $2 LIMIT 1) AND created_at >= $1 AND created_at < $2",
                              [mid, mid + datetime.timedelta(days=1)]),
        "month_count": ("SELECT count(*) FROM mqtt_messages WHERE created_at >= $1 AND created_at < $2", [lo, hi]),
    }
    out = {"label": a.label, "month": a.month, "queries": {}}
    for name, (sql, args) in queries.items():
        restart_and_drop(a.pgdata)
        cold, n = await run_once(a.dsn, sql, args)
        warm = [(await run_once(a.dsn, sql, args))[0] for _ in range(a.warm_runs)]
        out["queries"][name] = {"rows": n, "cold_ms": round(cold * 1000, 1),
                                "warm_median_ms": round(statistics.median(warm) * 1000, 2),
                                "warm_min_ms": round(min(warm) * 1000, 2)}
        print(f"{a.label:8s} {name:22s} rows={n:4d} cold={cold*1000:9.1f} ms  warm={statistics.median(warm)*1000:8.2f} ms")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, separators=(",", ":"))


if __name__ == "__main__":
    asyncio.run(main())
