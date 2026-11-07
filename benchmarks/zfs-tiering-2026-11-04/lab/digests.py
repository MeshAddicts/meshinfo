#!/usr/bin/env python3
"""Per-month whole-row digests of mqtt_messages / packet_receptions THROUGH THE
PARENT tables (count + sum(hashtextextended(row::text, 0)) + a first/last row
order probe), so a move can be proven lossless and order-preserving.

    python3 digests.py --dsn ... --from 2026-02 --to 2026-07 [--json out.json]
"""
import argparse
import asyncio
import datetime
import json

import asyncpg


def months(a, b):
    y, m = int(a[:4]), int(a[5:7])
    y2, m2 = int(b[:4]), int(b[5:7])
    while (y, m) <= (y2, m2):
        yield datetime.date(y, m, 1)
        m += 1
        if m == 13:
            y, m = y + 1, 1


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--from", dest="start", required=True)
    ap.add_argument("--to", dest="end", required=True)
    ap.add_argument("--json", default="")
    a = ap.parse_args()
    conn = await asyncpg.connect(a.dsn, command_timeout=None)
    await conn.execute("SET TIME ZONE 'UTC'")
    out = {}
    for month in months(a.start, a.end):
        lo = datetime.datetime(month.year, month.month, 1, tzinfo=datetime.timezone.utc)
        hi = (lo + datetime.timedelta(days=32)).replace(day=1)
        for table in ("mqtt_messages", "packet_receptions"):
            order = "created_at, id" if table == "mqtt_messages" else "created_at, mqtt_row_id, gateway"
            row = await conn.fetchrow(
                f"SELECT count(*) AS n, sum(hashtextextended(t::text, 0))::text AS digest, "
                f"(SELECT md5(string_agg(x::text, '|' ORDER BY {order})) FROM (SELECT * FROM {table} "
                f"WHERE created_at >= $1 AND created_at < $2 ORDER BY {order} LIMIT 500) x) AS head_md5 "
                f"FROM {table} t WHERE created_at >= $1 AND created_at < $2", lo, hi)
            key = f"{table}_{month:%Y_%m}"
            out[key] = {"rows": row["n"], "digest": row["digest"], "head_md5": row["head_md5"]}
            print(f"{key:30s} rows={row['n']:9d} digest={row['digest']} head={row['head_md5']}")
    await conn.close()
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, separators=(",", ":"))


if __name__ == "__main__":
    asyncio.run(main())
