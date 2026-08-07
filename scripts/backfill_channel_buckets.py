#!/usr/bin/env python3
"""One-time, idempotent backfill: re-file historical chat rows that were bucketed
by a gateway slot index instead of a channel hash.

`MeshPacket.channel` carries the (name, PSK) hash on encrypted uplinks but the
uplinking gateway's local slot index (0-7) once a gateway running with
`mqtt.encryption_enabled = false` has decoded the packet. Before the ingest fix
both were stored verbatim in chat_messages.channel_id, so one logical channel
split across buckets and slot indices from unrelated gateways collided.

Which bucket a row landed in is recoverable because the gateway also published
the channel name, in the MQTT topic (`.../2/e/<name>/<gateway>`), archived in
mqtt_messages.topic and joinable on packet id.

The canonical hash per name is LEARNED FROM OBSERVATION, never computed from a
PSK. Computing needs the channel's key, which we do not have for a decoded
packet, and a wrong key yields a plausible bucket that cannot be distinguished
from a real one. Observed live: `Test` computes to 52 under the default PSK but
its encrypted copies carry 120 — a computed backfill would have moved 563 rows
into a bucket that never existed. A name with no hash ever observed is skipped,
not guessed.

Only chat_messages is rewritten. mqtt_messages is left strictly alone: every
packet_receptions.extras patch was computed as a diff against the stored
canonical payload, so rewriting it would corrupt reconstruct_copy().

Dry-run by default. Safe to interrupt and re-run.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from collections import defaultdict
from pathlib import Path

import asyncpg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from channels import MAX_CHANNEL_INDEX, PKI_CHANNEL  # noqa: E402


def _dsn_from_config(path: Path) -> str:
    """Build a DSN from config.toml's [storage.postgres] section."""
    import tomllib

    with open(path, "rb") as f:
        pg = tomllib.load(f).get("storage", {}).get("postgres", {})
    return (
        f"postgresql://{pg.get('username', 'postgres')}:{pg.get('password', 'password')}"
        f"@{pg.get('host', 'postgres')}:{pg.get('port', 5432)}/{pg.get('database', 'meshinfo')}"
    )


# name -> hash, straight off the wire: ingest writes the gateway-supplied name
# onto the bucket the encrypted copies carry. No join needed, and no PSK.
# Buckets still holding a synthesized placeholder never saw post-fix traffic and
# are deliberately not trusted.
OBSERVE_SQL = """
SELECT id AS bucket, name
FROM chat_channels
WHERE id ~ '^[0-9]+$'
  AND id::int > $1
  AND name !~ '^(General|Channel [0-9]+)$'
"""

# Only index-range rows need the archive join. mqtt_messages has no standalone
# index on packet_id, so each probe scans the partitions — keep this set small
# (it is: these are exactly the mis-bucketed rows).
#
# Two correctness details, both learned the hard way:
#  * Mesh packet ids are 32-bit and DO collide across nodes (180 chat rows match
#    more than one archived row here). Matching on from_node_id as well, and
#    ordering deterministically, stops the answer depending on the query plan.
#  * packet_id is NULL for every archived row before 2026-07-11, so a join on it
#    alone reports "no archive" for rows whose topic is sitting right there.
#    Fall back to reading the id out of the payload. A regex, not ::jsonb —
#    undecryptable payloads contain \\u0000 and break the cast.
INDEX_ROWS_SQL = """
SELECT c.id,
       c.channel_id AS bucket,
       substring(m.topic from '/2/e/([^/]+)/') AS name
FROM chat_messages c
JOIN LATERAL (
    SELECT m2.topic
    FROM mqtt_messages m2
    WHERE (m2.packet_id = c.id
           OR (m2.packet_id IS NULL
               AND substring(m2.payload from '"id": ([0-9]+)') = c.id::text))
      AND (m2.from_node_id IS NULL OR m2.from_node_id = c.from_node_id)
    ORDER BY m2.created_at
    LIMIT 1
) m ON TRUE
WHERE c.channel_id ~ '^[0-9]$' AND c.channel_id::int <= $1
ORDER BY c.id
"""


def canonical_hashes(rows):
    """name -> canonical bucket, plus notes on anything ambiguous.

    A bucket above the index range cannot be a slot index, so it is a real hash.
    If one name somehow holds two, it is not safe to pick — skip and report.
    """
    seen = defaultdict(list)
    for r in rows:
        seen[r["name"]].append(r["bucket"])

    resolved, notes = {}, {}
    for name, buckets in seen.items():
        if name == PKI_CHANNEL:
            notes[name] = "PKI pseudo-channel — no real channel behind it"
            continue
        if len(buckets) > 1:
            notes[name] = f"ambiguous: name maps to buckets {sorted(buckets)} — skipped"
            continue
        resolved[name] = buckets[0]
    return resolved, notes


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=Path, default=Path("config.toml"))
    ap.add_argument("--dsn", help="Override the DSN from config.toml")
    ap.add_argument("--apply", action="store_true",
                    help="Actually write. Without this, reports and exits.")
    ap.add_argument("--batch", type=int, default=500)
    args = ap.parse_args()

    dsn = args.dsn or _dsn_from_config(args.config)
    conn = await asyncpg.connect(dsn)
    try:
        observed = await conn.fetch(OBSERVE_SQL, MAX_CHANNEL_INDEX)
        resolved, notes = canonical_hashes(observed)

        print("Wire-confirmed buckets (channel names learned from encrypted uplinks):")
        for name, bucket in sorted(resolved.items()):
            print(f"  {name:20s} -> {bucket}")
        if notes:
            print("\nNot usable as targets:")
            for name, why in sorted(notes.items()):
                print(f"  {name:20s} {why}")

        # Plan: index-range rows whose name resolves somewhere else.
        grouped = defaultdict(list)
        unresolvable = defaultdict(int)
        for r in await conn.fetch(INDEX_ROWS_SQL, MAX_CHANNEL_INDEX):
            name = r["name"]
            if not name:
                continue
            target = resolved.get(name)
            if target is None:
                unresolvable[name] += 1
                continue
            if target == r["bucket"]:
                continue
            grouped[(name, r["bucket"], target)].append(r["id"])

        plan = [(n, b, t, ids) for (n, b, t), ids in grouped.items()]
        total = sum(len(ids) for *_, ids in plan)

        if unresolvable:
            print("\nLeft alone — no wire-confirmed hash for these names:")
            for name, n in sorted(unresolvable.items(), key=lambda kv: -kv[1]):
                print(f"  {n:6d}  {name}")
        print(f"\n{'Would re-file' if not args.apply else 'Re-filing'} {total} row(s):")
        for name, bucket, target, ids in sorted(plan, key=lambda p: -len(p[3])):
            print(f"  {len(ids):6d}  {name:20s} {bucket} -> {target}")

        stranded = await conn.fetchval(
            """
            SELECT COUNT(*) FROM chat_messages c
            WHERE c.channel_id ~ '^[0-7]$'
              AND NOT EXISTS (
                  SELECT 1 FROM mqtt_messages m
                  WHERE (m.packet_id = c.id
                         OR (m.packet_id IS NULL
                             AND substring(m.payload from '"id": ([0-9]+)') = c.id::text))
                    AND (m.from_node_id IS NULL OR m.from_node_id = c.from_node_id)
              )
            """
        )
        if stranded:
            print(f"\n{stranded} index-bucket row(s) have no archived copy at all "
                  f"and stay where they are — unrecoverable.")

        if not total:
            print("\nNothing to do.")
            return 0
        if not args.apply:
            print("\nDry run. Re-run with --apply to write. Back up first:")
            print("  docker compose exec postgres pg_dump -U postgres -t chat_messages "
                  "-t chat_channels meshinfo > chat_backup.sql")
            return 0

        moved = 0
        for name, bucket, target, ids in plan:
            # FK target must exist before rows point at it.
            await conn.execute(
                """
                INSERT INTO chat_channels (id, name) VALUES ($1, $2)
                ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
                WHERE chat_channels.name IS DISTINCT FROM EXCLUDED.name
                """,
                target, name[:100],
            )
            for i in range(0, len(ids), args.batch):
                chunk = ids[i:i + args.batch]
                async with conn.transaction():
                    await conn.execute(
                        "UPDATE chat_messages SET channel_id = $1 WHERE id = ANY($2::bigint[])",
                        target, chunk,
                    )
                moved += len(chunk)
                print(f"  ... {moved}/{total}", end="\r", flush=True)

        print(f"\nDone. Re-filed {moved} row(s).")
        print("Empty source buckets are left in chat_channels; the UI hides "
              "channels with no data.")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
