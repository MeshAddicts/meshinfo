#!/usr/bin/env python3
"""Measure the swap's hold on an otherwise idle server: hammer the parent with
a trivial query every few milliseconds while one partition moves, and report
the longest request — with nothing in flight, the DETACH's lock is granted at
once, so that longest request is the swap's own hold (DETACH .. COMMIT).

    python3 hold_probe.py --dsn ... --stop-file /lab/hold.stop --json out.json
"""
import argparse
import asyncio
import json
import os
import time

import asyncpg


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--stop-file", required=True)
    ap.add_argument("--json", required=True)
    ap.add_argument("--every-ms", type=float, default=5.0)
    a = ap.parse_args()
    conn = await asyncpg.connect(a.dsn)
    samples = []
    t0 = time.monotonic()
    while not os.path.exists(a.stop_file):
        s = time.monotonic()
        await conn.fetchval("SELECT count(*) FROM mqtt_messages WHERE false")
        samples.append((round(s - t0, 3), round((time.monotonic() - s) * 1000, 2)))
        await asyncio.sleep(a.every_ms / 1000)
    await conn.close()
    lat = sorted(ms for _, ms in samples)
    n = len(lat)
    out = {
        "requests": n,
        "p50_ms": lat[n // 2] if n else None,
        "p99_ms": lat[min(n - 1, round(0.99 * (n - 1)))] if n else None,
        "max_ms": lat[-1] if n else None,
        "over_100ms": sum(1 for _, ms in samples if ms > 100),
        "slowest": sorted(samples, key=lambda x: -x[1])[:12],
    }
    with open(a.json, "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
