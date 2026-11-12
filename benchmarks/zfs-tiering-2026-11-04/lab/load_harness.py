#!/usr/bin/env python3
"""Concurrent reader + writer load against the MeshInfo archive while a tiering
move runs. Readers issue the app's representative queries (latest page, node
page, topic filter, cold-month window page, permalink + receptions, 24h stats);
writers insert canonical packets + receptions into the current month through
the parent tables, exactly like ingest. Records latencies and errors.

    python3 load_harness.py --dsn ... --seconds 120 --readers 6 --writers 2 \
        --cold-month 2026-06 --json out.json
Stops early when --stop-file appears.

--slow-every N adds a "slow" client: every N seconds it holds ACCESS SHARE on
mqtt_messages for several seconds (a payload ILIKE sequential scan over the
cold month, --slow-scans times inside one transaction) — the long in-flight
query that the swap's ACCESS EXCLUSIVE request has to wait for, during which
every other request on the parent queues behind the swap. Its own latency is
reported as op "slow"; the api_* figures exclude it, so api_max_ms is the
longest stall any ordinary request saw.
"""
import argparse
import asyncio
import json
import os
import random
import statistics
import time

import asyncpg

RECEPTION_COUNT_SQL = (
    "(SELECT count(*) FROM packet_receptions pr WHERE pr.mqtt_row_id = mqtt_messages.id "
    "AND pr.created_at >= mqtt_messages.created_at "
    "AND pr.created_at < mqtt_messages.created_at + interval '86400 seconds')"
)
PAGE = f"""SELECT id, topic, payload, qos, retain, timestamp, created_at, {RECEPTION_COUNT_SQL} AS reception_count
           FROM mqtt_messages {{where}} ORDER BY created_at DESC, id DESC LIMIT 101"""


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(p / 100.0 * (len(s) - 1)))))
    return s[k]


class Stats:
    def __init__(self):
        self.lat = {}
        self.errors = {}
        self.error_samples = []
        self.t0 = time.time()
        self.slowest = []  # (seconds since start, op, latency) of the slowest ordinary requests

    def ok(self, op, dt):
        self.lat.setdefault(op, []).append(dt)
        if op != "slow":
            self.slowest.append((round(time.time() - self.t0, 1), op, dt))
            if len(self.slowest) > 400:
                self.slowest.sort(key=lambda s: -s[2])
                del self.slowest[40:]

    def err(self, op, e):
        self.errors[op] = self.errors.get(op, 0) + 1
        if len(self.error_samples) < 20:
            self.error_samples.append(f"{op}: {type(e).__name__}: {str(e)[:200]}")

    def summary(self):
        out = {"ops": {}, "errors": self.errors, "error_samples": self.error_samples}
        total = 0
        for op, v in self.lat.items():
            total += len(v)
            out["ops"][op] = {
                "n": len(v), "p50_ms": round(pct(v, 50) * 1000, 2), "p95_ms": round(pct(v, 95) * 1000, 2),
                "p99_ms": round(pct(v, 99) * 1000, 2), "max_ms": round(max(v) * 1000, 2),
                "mean_ms": round(statistics.fmean(v) * 1000, 2),
            }
        allv = [x for v in self.lat.values() for x in v]
        out["total_ok"] = total
        out["total_errors"] = sum(self.errors.values())
        out["all_p50_ms"] = round(pct(allv, 50) * 1000, 2) if allv else None
        out["all_p99_ms"] = round(pct(allv, 99) * 1000, 2) if allv else None
        out["all_max_ms"] = round(max(allv) * 1000, 2) if allv else None
        # The ordinary requests only (the slow client's scans are the cause, not the symptom).
        api = [x for op, v in self.lat.items() if op != "slow" for x in v]
        out["api_ok"] = len(api)
        out["api_p50_ms"] = round(pct(api, 50) * 1000, 2) if api else None
        out["api_p99_ms"] = round(pct(api, 99) * 1000, 2) if api else None
        out["api_max_ms"] = round(max(api) * 1000, 2) if api else None
        out["api_over_1s"] = sum(1 for x in api if x > 1.0)
        out["api_over_3s"] = sum(1 for x in api if x > 3.0)
        self.slowest.sort(key=lambda s: -s[2])
        out["slowest"] = [(t, op, round(dt * 1000, 1)) for t, op, dt in self.slowest[:40]]
        return out


SLOW_SCAN_SQL = ("SELECT count(*) FROM mqtt_messages WHERE created_at >= $1 AND created_at < $2 "
                 "AND payload ILIKE '%zzqx-needle-that-never-matches%'")


async def slow_reader(dsn, stats, stop, lo, hi, every, scans):
    """Every `every` seconds: one transaction that sequentially scans the cold
    month `scans` times with a payload ILIKE — several seconds of ACCESS SHARE
    on the parent, the realistic worst case for the swap's lock request."""
    conn = await asyncpg.connect(dsn, command_timeout=None)
    try:
        while not stop.is_set():
            t0 = time.perf_counter()
            try:
                async with conn.transaction():
                    for _ in range(scans):
                        await conn.fetchval(SLOW_SCAN_SQL, lo, hi)
                stats.ok("slow", time.perf_counter() - t0)
            except Exception as e:  # noqa: BLE001
                stats.err("slow", e)
            remaining = every - (time.perf_counter() - t0)
            while remaining > 0 and not stop.is_set():
                await asyncio.sleep(min(0.5, remaining))
                remaining -= 0.5
    finally:
        await conn.close()


async def reader(dsn, stats, stop, cold_lo, cold_hi, node_ids, row_ids, rnd):
    conn = await asyncpg.connect(dsn, command_timeout=10)
    try:
        while not stop.is_set():
            op = rnd.choice(["latest", "latest", "node", "topic", "cold_window", "permalink", "permalink", "stats"])
            t0 = time.perf_counter()
            try:
                if op == "latest":
                    await conn.fetch(PAGE.format(where=""))
                elif op == "node":
                    nid = rnd.choice(node_ids)
                    await conn.fetch(PAGE.format(where="WHERE (from_node_id = $1 OR to_node_id = $1)"), nid)
                elif op == "topic":
                    await conn.fetch(PAGE.format(where="WHERE topic ILIKE '%' || $1 || '%' ESCAPE '\\'"), "LongFast")
                elif op == "cold_window":
                    await conn.fetch(PAGE.format(where="WHERE created_at >= $1 AND created_at <= $2"),
                                     cold_lo, cold_hi)
                elif op == "permalink":
                    rid = rnd.choice(row_ids)
                    row = await conn.fetchrow(
                        "SELECT id, topic, payload, qos, retain, timestamp, created_at FROM mqtt_messages WHERE id = $1", rid)
                    if row is not None:
                        await conn.fetch(
                            "SELECT pr.gateway, t.topic, pr.rx_rssi, pr.rx_snr, pr.rx_time, pr.hop_limit, pr.hops_away, "
                            "pr.relay_node, pr.transport, pr.extras, pr.created_at FROM packet_receptions pr "
                            "LEFT JOIN mqtt_topics t ON t.id = pr.topic_id WHERE pr.mqtt_row_id = $1 "
                            "AND pr.created_at >= $2 AND pr.created_at < $2 + interval '86400 seconds' "
                            "ORDER BY pr.created_at, pr.gateway", rid, row["created_at"])
                elif op == "stats":
                    await conn.fetchval(
                        "SELECT count(*) FROM packet_receptions WHERE created_at > now() - interval '24 hours'")
                stats.ok(op, time.perf_counter() - t0)
            except Exception as e:  # noqa: BLE001
                stats.err(op, e)
                await asyncio.sleep(0.2)
            await asyncio.sleep(rnd.uniform(0.01, 0.05))
    finally:
        await conn.close()


async def writer(dsn, stats, stop, rnd, topic_ids):
    conn = await asyncpg.connect(dsn, command_timeout=10)
    pkt = rnd.randrange(1, 2 ** 31)
    try:
        while not stop.is_set():
            pkt += 1
            frm = rnd.randrange(0x10000000, 0xFFFFFFFF)
            payload = json.dumps({
                "from": frm, "to": 4294967295, "id": pkt, "channel": 8, "hop_limit": 3, "hop_start": 3,
                "rx_time": int(time.time()), "rx_snr": round(rnd.uniform(-20, 12), 2), "rx_rssi": -rnd.randrange(40, 130),
                "sender": "!aabbccdd", "topic": "msh/US/CA/Lab/2/e/LongFast/!aabbccdd", "timestamp": int(time.time()),
                "type": "position", "payload": {"latitude_i": 385000000 + rnd.randrange(0, 100000),
                                                 "longitude_i": -1214000000 + rnd.randrange(0, 100000),
                                                 "altitude": rnd.randrange(0, 2000), "time": int(time.time()),
                                                 "precision_bits": 32, "sats_in_view": 9, "PDOP": 150,
                                                 "ground_speed": 0, "ground_track": 0},
                "want_ack": False, "priority": "BACKGROUND", "via_mqtt": False, "qos": 0, "retain": False,
            }, ensure_ascii=False)
            t0 = time.perf_counter()
            try:
                async with conn.transaction():
                    rid = await conn.fetchval(
                        "INSERT INTO mqtt_messages (topic, payload, qos, retain, timestamp, from_node_id, to_node_id, packet_id) "
                        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
                        "msh/US/CA/Lab/2/e/LongFast/!aabbccdd", payload, 0, False, int(time.time()),
                        f"{frm:08x}", "ffffffff", pkt)
                    for _ in range(rnd.randrange(1, 6)):
                        await conn.execute(
                            "INSERT INTO packet_receptions (mqtt_row_id, gateway, topic_id, rx_rssi, rx_snr, rx_time, "
                            "hop_limit, hops_away, relay_node, transport, extras) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
                            rid, f"{rnd.randrange(0x10000000, 0xFFFFFFFF):08x}", rnd.choice(topic_ids),
                            -rnd.randrange(40, 130), rnd.uniform(-20, 12), int(time.time()), 3, rnd.randrange(0, 4),
                            None, 1, None)
                stats.ok("write", time.perf_counter() - t0)
            except Exception as e:  # noqa: BLE001
                stats.err("write", e)
                await asyncio.sleep(0.2)
            await asyncio.sleep(0.05)
    finally:
        await conn.close()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--seconds", type=float, default=120)
    ap.add_argument("--readers", type=int, default=6)
    ap.add_argument("--writers", type=int, default=2)
    ap.add_argument("--cold-month", default="2026-06", help="YYYY-MM used for the window page query")
    ap.add_argument("--stop-file", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--slow-every", type=float, default=0,
                    help="seconds between the slow client's whole-month ILIKE scans (0 = no slow client)")
    ap.add_argument("--slow-scans", type=int, default=4,
                    help="scans per slow transaction (each a few hundred ms warm; together they hold ACCESS SHARE)")
    a = ap.parse_args()
    y, m = int(a.cold_month[:4]), int(a.cold_month[5:7])
    import datetime
    lo = datetime.datetime(y, m, 10, tzinfo=datetime.timezone.utc)
    hi = lo + datetime.timedelta(days=3)
    month_lo = datetime.datetime(y, m, 1, tzinfo=datetime.timezone.utc)
    month_hi = datetime.datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=datetime.timezone.utc)
    conn = await asyncpg.connect(a.dsn)
    node_ids = [r[0] for r in await conn.fetch(
        "SELECT from_node_id FROM mqtt_messages WHERE created_at >= $1 AND created_at < $2 AND from_node_id IS NOT NULL "
        "LIMIT 2000", lo, hi)] or ["00000001"]
    row_ids = [r[0] for r in await conn.fetch(
        "SELECT id FROM mqtt_messages WHERE created_at >= $1 AND created_at < $2 LIMIT 5000", lo, hi)] or [1]
    topic_ids = [r[0] for r in await conn.fetch("SELECT id FROM mqtt_topics LIMIT 50")]
    if not topic_ids:
        topic_ids = [await conn.fetchval(
            "INSERT INTO mqtt_topics (topic) VALUES ('msh/US/CA/Lab/2/e/LongFast/!aabbccdd') "
            "ON CONFLICT (topic) DO UPDATE SET topic = EXCLUDED.topic RETURNING id")]
    await conn.close()
    stats = Stats()
    stop = asyncio.Event()
    tasks = [asyncio.create_task(reader(a.dsn, stats, stop, lo, hi, node_ids, row_ids, random.Random(a.seed + i)))
             for i in range(a.readers)]
    tasks += [asyncio.create_task(writer(a.dsn, stats, stop, random.Random(a.seed + 100 + i), topic_ids))
              for i in range(a.writers)]
    if a.slow_every > 0:
        tasks.append(asyncio.create_task(slow_reader(a.dsn, stats, stop, month_lo, month_hi,
                                                     a.slow_every, max(1, a.slow_scans))))
    t0 = time.time()
    stats.t0 = t0
    while time.time() - t0 < a.seconds:
        if a.stop_file and os.path.exists(a.stop_file):
            break
        await asyncio.sleep(0.5)
    stop.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    out = stats.summary()
    out["seconds"] = round(time.time() - t0, 1)
    out["readers"], out["writers"] = a.readers, a.writers
    out["slow_every"], out["slow_scans"] = a.slow_every, a.slow_scans
    print(json.dumps(out, indent=1))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, separators=(",", ":"))


if __name__ == "__main__":
    asyncio.run(main())
