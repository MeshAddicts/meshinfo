#!/usr/bin/env python3
"""One-time, idempotent repair for #575: node_positions rows stuck behind the
freshness guard. Three ways a row gets stuck: manual/fixed positions carry no
GPS time and are rejected forever once any timestamped position was stored; a
future-skewed GPS clock poisons the row against all later honest packets; a
coordinate-less timed payload wipes the row's coordinates entirely.
Re-applies each node's newest archived POSITION packet from mqtt_messages,
deriving position.time exactly like fixed ingest does (payload time when sane,
else the packet's rx_time, bounded by its arrival). Never writes a position
older than the stored one unless the stored row is future-poisoned or has no
coordinates left to defend.
Dry-run by default. Safe to re-run and to run alongside live ingest — but
deploy the fixed ingest FIRST (pre-fix ingest can't update the stamped rows),
and restart meshinfo afterwards so the node cache reloads the repaired rows.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import sys
import time
from pathlib import Path

import asyncpg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from utils import FUTURE_CLOCK_TOLERANCE_S, normalize_node_id  # noqa: E402

# Single-instance guard; arbitrary constant, held for the connection's lifetime.
ADVISORY_LOCK_KEY = 0x6D65_7370_6F73  # "mespos"

INT32_MAX = 2**31 - 1
INT16_MAX = 2**15 - 1

BACKUP_HINT = (
    "  docker compose exec postgres pg_dump -U postgres -t node_positions "
    "meshinfo > node_positions_backup.sql"
)


def _connect_kwargs(path: Path) -> dict:
    """Connection kwargs from config.toml's [storage.postgres] section.
    Kwargs, not a DSN string — passwords with @:/#% must not break parsing."""
    import tomllib

    try:
        with open(path, "rb") as f:
            pg = tomllib.load(f).get("storage", {}).get("postgres", {})
    except FileNotFoundError:
        sys.exit(f"{path} not found — run from the repo root (or pass "
                 f"--config/--dsn).")
    return {
        "user": pg.get("username", "postgres"),
        "password": pg.get("password", "password"),
        "host": pg.get("host", "postgres"),
        "port": pg.get("port", 5432),
        "database": pg.get("database", "meshinfo"),
    }


# Newest 8 position rows per node, narrow columns so the sort stays small;
# LIKE patterns match the app's json.dumps spacing, Python re-validates anyway.
# {days}/{node_filter} interpolate validated values (CTAS can't take binds).
LATEST_TABLE_SQL = """
CREATE TEMP TABLE _pr_latest AS
SELECT node_id, id, created_at FROM (
    SELECT m.from_node_id AS node_id, m.id, m.created_at,
           row_number() OVER (PARTITION BY m.from_node_id
                              ORDER BY m.created_at DESC) AS rn
    FROM mqtt_messages m
    WHERE m.created_at > now() - interval '{days} days'
      AND m.from_node_id IS NOT NULL
      AND m.payload LIKE '%"type": "position"%'
      AND m.payload LIKE '%"latitude_i"%'
      {node_filter}
) w
WHERE rn <= 8
"""

WINNER_PAYLOADS_SQL = """
SELECT w.node_id, w.created_at, m.timestamp, m.payload
FROM _pr_latest w
JOIN mqtt_messages m ON m.id = w.id AND m.created_at = w.created_at
ORDER BY w.node_id, w.created_at DESC
"""

STORED_SQL = """
SELECT node_id, latitude_i, longitude_i, altitude, time
FROM node_positions
"""

# Only overwrite a NULL, older-or-equal, future-poisoned (DB-side now(), can't
# go stale mid-run), or coordinate-less stored row; geocode drops on coord moves.
UPDATE_SQL = """
UPDATE node_positions SET
    latitude_i = $2, longitude_i = $3, altitude = $4, time = $5,
    precision_bits = $6, location_source = $7, altitude_hae = $8,
    altitude_geoidal_separation = $9, altitude_source = $10,
    geocoded = CASE WHEN latitude_i IS DISTINCT FROM $2
                      OR longitude_i IS DISTINCT FROM $3
               THEN NULL ELSE geocoded END,
    last_geocoding = CASE WHEN latitude_i IS DISTINCT FROM $2
                            OR longitude_i IS DISTINCT FROM $3
                     THEN NULL ELSE last_geocoding END
WHERE node_id = $1
  AND (latitude_i IS DISTINCT FROM $2 OR longitude_i IS DISTINCT FROM $3
       OR time IS DISTINCT FROM $5)
  AND (time IS NULL OR time <= $5
       OR time > EXTRACT(EPOCH FROM now())::int + $11
       OR latitude_i IS NULL OR longitude_i IS NULL)
"""


def _as_int(v, lo: int, hi: int):
    """v as an int within [lo, hi], else None (bool/NaN/inf/junk all None)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    try:
        i = int(v)
    except (ValueError, OverflowError):  # NaN / inf
        return None
    # Bound the raw value (not the truncation) so the mirror matches ingest.
    return i if lo <= v <= hi else None


def _updated_count(tag: str) -> int:
    try:
        return int(tag.split()[-1])
    except (ValueError, IndexError, AttributeError):
        return 0


def _effective_time(payload_time, rx_time, arrival_epoch: int) -> int:
    """Mirror of the ingest stamp: payload time when present and sane, else
    rx_time; both bounded by the row's server-side arrival (pre-clamp-era rows
    can carry future rx_time). One shared ceiling — stacking the two tolerances
    would let results exceed the guard's poison floor."""
    ceiling = arrival_epoch + FUTURE_CLOCK_TOLERANCE_S
    rx = _as_int(rx_time, 1, ceiling)
    if rx is None:
        rx = arrival_epoch
    t = _as_int(payload_time, 1, ceiling)
    return t if t is not None else rx


def _evidence_from_row(row) -> dict | None:
    """Parse one archived message row into a position candidate, or None.
    Bounds match the column types — the JSON-decoder path archives arbitrary
    publisher JSON, so wild values must die here, not in the UPDATE."""
    try:
        msg = json.loads(row["payload"])
    except (TypeError, ValueError):
        return None
    # Retained replays are stale by definition — ingest refuses to stamp them.
    if not isinstance(msg, dict) or msg.get("type") != "position" or msg.get("retain"):
        return None
    p = msg.get("payload")
    if not isinstance(p, dict):
        return None
    lat = _as_int(p.get("latitude_i"), -900_000_000, 900_000_000)
    lon = _as_int(p.get("longitude_i"), -1_800_000_000, 1_800_000_000)
    # Any zero axis is no-fix/junk from broken publishers, not a real fix —
    # too weak to serve as repair evidence.
    if not lat or not lon:
        return None
    arrival = int(row["created_at"].timestamp())
    return {
        "latitude_i": lat,
        "longitude_i": lon,
        "altitude": _as_int(p.get("altitude"), -INT32_MAX - 1, INT32_MAX),
        "time": _effective_time(p.get("time"), row["timestamp"], arrival),
        "precision_bits": _as_int(p.get("precision_bits"), 0, INT32_MAX),
        "location_source": _as_int(p.get("location_source"), 0, INT16_MAX),
        "altitude_hae": _as_int(p.get("altitude_hae"), -INT32_MAX - 1, INT32_MAX),
        "altitude_geoidal_separation": _as_int(
            p.get("altitude_geoidal_separation"), -INT32_MAX - 1, INT32_MAX),
        "altitude_source": _as_int(p.get("altitude_source"), 0, INT16_MAX),
    }


def _fmt_pos(lat_i, lon_i, t) -> str:
    coords = (
        f"{lat_i / 1e7:.4f},{lon_i / 1e7:.4f}"
        if lat_i is not None and lon_i is not None
        else "none"
    )
    when = (
        datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M")
        if t
        else "no time"
    )
    return f"{coords} @ {when}"


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=Path, default=Path("config.toml"))
    ap.add_argument("--dsn", help="Override the connection settings from config.toml")
    ap.add_argument("--apply", action="store_true",
                    help="Actually write. Without this, reports and exits.")
    ap.add_argument("--days", type=int, default=90,
                    help="Archive window to draw evidence from (default 90)")
    ap.add_argument("--node", action="append", default=[],
                    help="Repair only these node id(s) (hex, repeatable)")
    ap.add_argument("--show", type=int, default=40,
                    help="Max planned changes to print (default 40)")
    args = ap.parse_args()

    wanted = None
    if args.node:
        wanted, bad = set(), []
        for raw in args.node:
            nid = normalize_node_id(raw)
            wanted.add(nid) if nid else bad.append(raw)
        if bad:
            print(f"Invalid --node id(s): {', '.join(bad)}")
            return 1

    if args.dsn:
        conn = await asyncpg.connect(args.dsn)
    else:
        conn = await asyncpg.connect(**_connect_kwargs(args.config))
    try:
        await conn.execute("SET statement_timeout = 0")
        await conn.execute("SET jit = off")
        if not await conn.fetchval(
            "SELECT pg_try_advisory_lock($1)", ADVISORY_LOCK_KEY
        ):
            print("Another instance of this script is already running. Exiting.")
            return 1

        node_filter = ""
        if wanted:
            ids = ",".join(f"'{n}'" for n in sorted(wanted))
            node_filter = f"AND m.from_node_id IN ({ids})"
        days = min(max(1, args.days), 3650)
        print(f"Scanning the last {days} day(s) of the archive for each "
              f"node's newest position packet...")
        try:
            await conn.execute(LATEST_TABLE_SQL.format(
                days=days, node_filter=node_filter))
        except asyncpg.UndefinedTableError:
            print("mqtt_messages does not exist — fresh install or wrong "
                  "database; nothing to repair.")
            return 1

        # Newest valid candidate per node (rows arrive newest-first per node);
        # streamed so memory stays O(nodes), not O(rows x payload).
        evidence: dict[str, dict] = {}
        async with conn.transaction():
            async for row in conn.cursor(WINNER_PAYLOADS_SQL, prefetch=500):
                nid = row["node_id"]
                if nid in evidence:
                    continue
                cand = _evidence_from_row(row)
                if cand is not None:
                    evidence[nid] = cand

        stored = {r["node_id"]: r for r in await conn.fetch(STORED_SQL)}
        if wanted:
            missing = sorted(wanted - evidence.keys())
            if missing:
                print(f"No archived position evidence for: {', '.join(missing)}")

        # Unattributed rows are invisible to the evidence scan.
        unattributed = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM mqtt_messages WHERE from_node_id IS NULL)"
        )
        if unattributed:
            print("WARNING: some archived rows lack from_node_id (the app's "
                  "node-ID backfill hasn't finished) — evidence may be partial.")

        # After the scan, so a long scan can't stale it into misclassifying
        # fresh live writes as poisoned.
        poison_floor = int(time.time()) + FUTURE_CLOCK_TOLERANCE_S

        plan = []  # (node_id, stored_row, cand, classification)
        considered = healthy = no_row = newer_stored = 0
        for nid, cand in sorted(evidence.items()):
            if wanted is not None and nid not in wanted:
                continue
            considered += 1
            cur = stored.get(nid)
            if cur is None:
                no_row += 1  # guard only strands existing rows; inserts are out of scope
                continue
            if cur["latitude_i"] is None or cur["longitude_i"] is None:
                # A row with no coordinates holds nothing worth defending —
                # its time is a wiper's, not a position's.
                plan.append((nid, cur, cand, "coordless-stored"))
                continue
            same_coords = (cur["latitude_i"] == cand["latitude_i"]
                           and cur["longitude_i"] == cand["longitude_i"])
            if same_coords and cur["time"] == cand["time"]:
                healthy += 1
                continue
            if cur["time"] is not None and cur["time"] > cand["time"] and cur["time"] <= poison_floor:
                newer_stored += 1  # stored beats the archive evidence; leave it
                continue
            if cur["time"] is not None and cur["time"] > poison_floor:
                why = "future-poisoned"
            elif cur["time"] is None:
                why = "timeless-stored"
            else:
                why = "stale"
            plan.append((nid, cur, cand, why))

        stored_ids = set(stored) if wanted is None else set(stored) & wanted
        no_evidence = len(stored_ids - evidence.keys())
        print(f"\nNodes with archived position evidence: {considered}"
              + (f" (of {len(evidence)} scanned)" if wanted else ""))
        print(f"  in sync already : {healthy}")
        print(f"  stored is newer : {newer_stored} (left alone)")
        print(f"  no stored row   : {no_row} (left alone)")
        print(f"  no evidence in window: {no_evidence} stored row(s) untouched")
        print(f"  to repair       : {len(plan)}")

        for nid, cur, cand, why in plan[: args.show]:
            print(f"  {nid}  [{why}]")
            print(f"      stored : {_fmt_pos(cur['latitude_i'], cur['longitude_i'], cur['time'])}")
            print(f"      archive: {_fmt_pos(cand['latitude_i'], cand['longitude_i'], cand['time'])}")
        if len(plan) > args.show:
            print(f"  ... and {len(plan) - args.show} more (raise --show to list)")

        if not args.apply:
            print("\nDry run only. Re-run with --apply to write (deploy the "
                  "fixed ingest first). Backup first:")
            print(BACKUP_HINT)
            return 0
        if not plan:
            print("\nNothing to repair.")
            return 0

        # Row-at-a-time autocommit: locks are held for microseconds, an
        # interrupt loses nothing (idempotent re-run), and a busy row is
        # skipped rather than stalling the run.
        await conn.execute("SET lock_timeout = '5s'")
        updated = locked = 0
        for nid, _cur, c, _why in plan:
            try:
                res = await conn.execute(
                    UPDATE_SQL, nid, c["latitude_i"], c["longitude_i"],
                    c["altitude"], c["time"], c["precision_bits"],
                    c["location_source"], c["altitude_hae"],
                    c["altitude_geoidal_separation"], c["altitude_source"],
                    FUTURE_CLOCK_TOLERANCE_S,
                )
            except asyncpg.exceptions.LockNotAvailableError:
                locked += 1
                continue
            updated += _updated_count(res)
        raced = len(plan) - updated - locked
        print(f"\nRepaired {updated} node(s)."
              + (f" {locked} lock-busy (re-run to retry)." if locked else "")
              + (f" {raced} changed underneath us (re-run to verify)." if raced else ""))
        print("Restart meshinfo so the in-memory node cache (and live SSE "
              "viewers) pick up the repaired rows.")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
