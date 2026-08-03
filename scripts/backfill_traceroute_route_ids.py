#!/usr/bin/env python3
"""One-time, idempotent backfill: normalize raw-int entries in
traceroutes.route_ids to canonical 8-hex strings. Strings and out-of-uint32
garbage stay byte-identical; safe to interrupt and re-run (batched commits).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

import asyncpg


def _dsn_from_config(path: Path) -> str:
    """Build a DSN from config.toml's [storage.postgres] section."""
    import tomllib

    with open(path, "rb") as f:
        pg = tomllib.load(f).get("storage", {}).get("postgres", {})
    return (
        f"postgresql://{pg.get('username', 'postgres')}:{pg.get('password', 'password')}"
        f"@{pg.get('host', 'postgres')}:{pg.get('port', 5432)}/{pg.get('database', 'meshinfo')}"
    )


# Preserves element order; only integral numbers within uint32 become hex.
NORMALIZE_SQL = """
UPDATE traceroutes
SET route_ids = (
    SELECT jsonb_agg(
        CASE
            WHEN jsonb_typeof(elem) = 'number'
                 AND (elem::text) ~ '^[0-9]+$'
                 AND (elem::text)::numeric <= 4294967295
            THEN to_jsonb(lpad(to_hex(((elem::text))::bigint), 8, '0'))
            ELSE elem
        END
        ORDER BY ord
    )
    FROM jsonb_array_elements(route_ids) WITH ORDINALITY AS t(elem, ord)
)
WHERE id = ANY($1::bigint[])
"""

# Dry-run MUST use this same predicate: out-of-uint32 raw echoes are kept
# on purpose, so a looser count would never reach zero.
AFFECTED_PREDICATE = """
jsonb_typeof(route_ids) = 'array'
  AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(route_ids) e
      WHERE jsonb_typeof(e) = 'number'
        AND (e::text) ~ '^[0-9]+$'
        AND (e::text)::numeric <= 4294967295
  )
"""

FIND_BATCH_SQL = f"""
SELECT id
FROM traceroutes
WHERE id > $1
  AND {AFFECTED_PREDICATE}
ORDER BY id
LIMIT $2
"""


async def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--dsn", help="postgres DSN (default: from --config)")
    ap.add_argument(
        "--config",
        default=str(Path(__file__).resolve().parents[1] / "config.toml"),
    )
    ap.add_argument("--batch-size", type=int, default=500)
    ap.add_argument(
        "--sleep", type=float, default=0.25, help="pause between batches (seconds)"
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="count affected rows and show a sample, change nothing",
    )
    args = ap.parse_args()

    dsn = args.dsn or _dsn_from_config(Path(args.config))
    conn = await asyncpg.connect(dsn)
    try:
        if args.dry_run:
            total = await conn.fetchval(
                f"SELECT count(*) FROM traceroutes WHERE {AFFECTED_PREDICATE}"
            )
            sample = await conn.fetch(
                f"""
                SELECT id, route_ids FROM traceroutes
                WHERE {AFFECTED_PREDICATE}
                ORDER BY id LIMIT 5
                """
            )
            print(f"rows the backfill will update: {total}")
            for r in sample:
                print(f"  id={r['id']}: {r['route_ids']}")
            return 0

        updated = 0
        last_id = 0
        started = time.monotonic()
        while True:
            ids = [
                r["id"]
                for r in await conn.fetch(FIND_BATCH_SQL, last_id, args.batch_size)
            ]
            if not ids:
                break
            await conn.execute(NORMALIZE_SQL, ids)
            updated += len(ids)
            last_id = ids[-1]
            print(f"updated {updated} rows (through id {last_id})", flush=True)
            await asyncio.sleep(args.sleep)

        print(f"done: {updated} rows normalized in {time.monotonic() - started:.1f}s")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
