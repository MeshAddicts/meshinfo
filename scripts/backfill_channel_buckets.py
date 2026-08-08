#!/usr/bin/env python3
"""One-time, idempotent backfill: re-file historical chat rows bucketed by a
gateway slot index (0-7, stamped on gateway-decoded uplinks) instead of the
(name, PSK) channel hash. The right bucket is recovered from the channel name
in the archived MQTT topic (`.../2/e/<name>/<gateway>`), joinable on packet id.
Canonical hash per name is LEARNED FROM OBSERVATION, never computed from a PSK —
a wrong key yields a plausible-looking bucket. Unobserved names are skipped.
Only chat_messages is rewritten; touching mqtt_messages would corrupt
reconstruct_copy(). Dry-run by default. Safe to interrupt and re-run.
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


# name -> hash from observed traffic: ingest stamps the gateway-supplied name on
# the hash bucket. Placeholder-named buckets saw no post-fix traffic; not trusted.
OBSERVE_SQL = """
SELECT id AS bucket, name
FROM chat_channels
WHERE id ~ '^[0-9]+$'
  AND id::int > $1
  AND name !~ '^(General|Channel [0-9]+)$'
"""

# Unindexed join; 32-bit packet ids collide across nodes — match from_node_id too, order deterministically.
# packet_id is NULL pre-2026-07-11: fall back to a payload regex, not ::jsonb (\\u0000 breaks the cast).
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


# last_channel 0-7 = stale slot indices. A payload channel >7 is a hash by
# definition; the node's latest such packet wins (handles genuine channel moves).
NODE_EVIDENCE_SQL = """
SELECT n.id, n.last_channel AS old_bucket, ev.hash::text AS new_bucket
FROM nodes n
JOIN LATERAL (
    SELECT substring(m.payload from '"channel": ([0-9]+)')::int AS hash
    FROM mqtt_messages m
    WHERE m.from_node_id = n.id
      AND substring(m.payload from '"channel": ([0-9]+)')::int BETWEEN 8 AND 255
    ORDER BY m.created_at DESC
    LIMIT 1
) ev ON TRUE
WHERE n.last_channel ~ '^[0-7]$'
ORDER BY n.id
"""


def canonical_hashes(rows):
    """name -> canonical bucket; a name holding two buckets is unsafe to pick —
    skipped and noted."""
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

        # ── nodes.last_channel pass ──
        node_moves = await conn.fetch(NODE_EVIDENCE_SQL)
        by_target: dict = defaultdict(list)
        for r in node_moves:
            by_target[(r["old_bucket"], r["new_bucket"])].append(r["id"])
        n_nodes = sum(len(v) for v in by_target.values())
        evidence_less = await conn.fetchval(
            """
            SELECT COUNT(*) FROM nodes n
            WHERE n.last_channel ~ '^[0-7]$'
              AND NOT EXISTS (
                  SELECT 1 FROM mqtt_messages m
                  WHERE m.from_node_id = n.id
                    AND substring(m.payload from '"channel": ([0-9]+)')::int BETWEEN 8 AND 255
              )
            """
        )
        print(f"\n{'Would re-file' if not args.apply else 'Re-filing'} {n_nodes} node(s) "
              f"by their own latest hash-carrying packet:")
        for (old_b, new_b), ids in sorted(by_target.items(), key=lambda kv: -len(kv[1])):
            print(f"  {len(ids):6d}  last_channel {old_b} -> {new_b}")
        if evidence_less:
            print(f"  {evidence_less} node(s) in index buckets have no hash-carrying "
                  f"packet at all — left alone (they heal if they ever transmit one).")

        if not total and not n_nodes:
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

        moved_nodes = 0
        for (old_b, new_b), ids in by_target.items():
            for i in range(0, len(ids), args.batch):
                chunk = ids[i:i + args.batch]
                async with conn.transaction():
                    # Guard on the old value: a node that transmitted between
                    # plan and write keeps its fresher ingest-stamped bucket.
                    await conn.execute(
                        """
                        UPDATE nodes SET last_channel = $1
                        WHERE id = ANY($3::varchar[]) AND last_channel = $2
                        """,
                        new_b, old_b, chunk,
                    )
                moved_nodes += len(chunk)

        print(f"\nDone. Re-filed {moved} chat row(s) and {moved_nodes} node(s).")
        print("Empty source buckets are left in chat_channels; the UI hides "
              "channels with no data.")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
