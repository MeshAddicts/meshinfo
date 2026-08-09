#!/usr/bin/env python3
"""One-time, idempotent backfill: re-file rows bucketed by a gateway slot index
(0-7, stamped on gateway-decoded uplinks) into their (name, PSK) channel hash.
Writes chat_messages.channel_id, nodes.last_channel, and chat_channels names;
never touches mqtt_messages. Buckets are recovered from each row's own archived
traffic; the name -> hash map is LEARNED FROM OBSERVATION, never PSK-computed —
a wrong key yields a plausible-looking bucket. Unobserved names are skipped.
Dry-run by default. Safe to interrupt, re-run, and run concurrently with ingest.
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

# Single-instance guard; arbitrary constant, held for the connection's lifetime.
ADVISORY_LOCK_KEY = 0x6D65_7368_6368  # "meshch"

BACKUP_HINT = (
    "  docker compose exec postgres pg_dump -U postgres -t chat_messages "
    "-t chat_channels -t nodes meshinfo > channel_backfill_backup.sql"
)


def _connect_kwargs(path: Path) -> dict:
    """Connection kwargs from config.toml's [storage.postgres] section.
    Kwargs, not a DSN string — passwords with @:/#% must not break parsing."""
    import tomllib

    with open(path, "rb") as f:
        pg = tomllib.load(f).get("storage", {}).get("postgres", {})
    return {
        "user": pg.get("username", "postgres"),
        "password": pg.get("password", "password"),
        "host": pg.get("host", "postgres"),
        "port": pg.get("port", 5432),
        "database": pg.get("database", "meshinfo"),
    }


# name -> hash from observed traffic: ingest stamps the gateway-supplied name on
# the hash bucket. Placeholder-named buckets saw no post-fix traffic; not trusted.
OBSERVE_SQL = """
SELECT id AS bucket, name
FROM chat_channels
WHERE id ~ '^[0-9]+$'
  AND id::bigint > $1
  AND name !~ '^(General|Channel [0-9]+)$'
"""

# Two set-based passes instead of a per-row LATERAL: pass 1 is one indexed join
# for rows with packet_id copies; pass 2 scans the packet_id-IS-NULL slice once.
# 32-bit packet ids collide across nodes — match from_node_id too (preflight
# guarantees it is populated) and bound to +-1 day so partitions prune.
PASS1_SQL = """
SELECT DISTINCT ON (c.id)
       c.id,
       c.channel_id AS bucket,
       substring(m.topic from '/2/e/([^/]+)/') AS name
FROM chat_messages c
JOIN mqtt_messages m
  ON m.from_node_id = c.from_node_id
 AND m.packet_id = c.id
 AND m.created_at BETWEEN c.created_at - interval '1 day'
                      AND c.created_at + interval '1 day'
WHERE c.channel_id ~ '^[0-9]$' AND c.channel_id::int <= $1
ORDER BY c.id, m.created_at
"""

# Rows pass 1 missed, materialized + ANALYZEd so the planner keeps pass 2 a
# single set-based scan rather than reverting to per-row probes.
MISSED_TABLE_SQL = """
CREATE TEMP TABLE _bf_missed AS
SELECT id, channel_id AS bucket, from_node_id, created_at
FROM chat_messages WITH NO DATA
"""

MISSED_FILL_SQL = """
INSERT INTO _bf_missed
SELECT c.id, c.channel_id, c.from_node_id, c.created_at
FROM chat_messages c
WHERE c.channel_id ~ '^[0-9]$' AND c.channel_id::int <= $1
  AND NOT EXISTS (
      SELECT 1 FROM mqtt_messages m
      WHERE m.from_node_id = c.from_node_id
        AND m.packet_id = c.id
        AND m.created_at BETWEEN c.created_at - interval '1 day'
                             AND c.created_at + interval '1 day'
  )
"""

# packet_id is NULL on old rows: match by payload regex, not ::jsonb
# (\\u0000 breaks the cast).
PASS2_SQL = """
SELECT DISTINCT ON (x.id)
       x.id,
       x.bucket,
       substring(m.topic from '/2/e/([^/]+)/') AS name
FROM _bf_missed x
JOIN mqtt_messages m
  ON m.packet_id IS NULL
 AND m.from_node_id = x.from_node_id
 AND substring(m.payload from '"id": ([0-9]+)') = x.id::text
 AND m.created_at BETWEEN x.created_at - interval '1 day'
                      AND x.created_at + interval '1 day'
ORDER BY x.id, m.created_at
"""

# last_channel 0-7 = stale slot indices. A payload channel >7 is a hash by
# definition; the node's latest such packet wins (handles genuine channel moves).
NODE_EVIDENCE_SQL = """
SELECT n.id, n.last_channel AS old_bucket, ev.hash::text AS new_bucket
FROM nodes n
JOIN LATERAL (
    SELECT substring(m.payload from '"channel": ([0-9]+)')::bigint AS hash
    FROM mqtt_messages m
    WHERE m.from_node_id = n.id
      AND substring(m.payload from '"channel": ([0-9]+)')::bigint BETWEEN 8 AND 255
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


def _updated_count(tag: str) -> int:
    """Row count from an asyncpg command tag like 'UPDATE 42'."""
    try:
        return int(tag.rsplit(" ", 1)[-1])
    except (ValueError, IndexError):
        return 0


async def _preflight(conn) -> str | None:
    """Reason this install isn't ready, or None. Never writes."""
    cols = {
        r["column_name"]
        for r in await conn.fetch(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'mqtt_messages'
              AND column_name IN ('packet_id', 'from_node_id')
            """
        )
    }
    missing = {"packet_id", "from_node_id"} - cols
    if missing:
        return (
            f"mqtt_messages is missing column(s) {sorted(missing)} — upgrade "
            "MeshInfo and start the app once so its schema migrations run."
        )
    # Unattributed rows would force every probe to scan them all (and reopen a
    # packet-id-collision path). The partial backfill index makes this check free.
    unattributed = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM mqtt_messages WHERE from_node_id IS NULL)"
    )
    if unattributed:
        return (
            "the archive still has rows without from_node_id — let the app's "
            "background node-ID backfill finish (watch for 'MQTT node-ID "
            "backfill: nothing to do' in the logs), then re-run."
        )
    return None


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=Path, default=Path("config.toml"))
    ap.add_argument("--dsn", help="Override the connection settings from config.toml")
    ap.add_argument("--apply", action="store_true",
                    help="Actually write. Without this, reports and exits.")
    ap.add_argument("--batch", type=int, default=500)
    args = ap.parse_args()
    batch = max(1, args.batch)

    if args.dsn:
        conn = await asyncpg.connect(args.dsn)
    else:
        conn = await asyncpg.connect(**_connect_kwargs(args.config))
    try:
        # Long read phase on big installs: no timeout, no JIT warm-up cost, and
        # exactly one instance at a time.
        await conn.execute("SET statement_timeout = 0")
        await conn.execute("SET jit = off")
        if not await conn.fetchval(
            "SELECT pg_try_advisory_lock($1)", ADVISORY_LOCK_KEY
        ):
            print("Another instance of this script is already running. Exiting.")
            return 1

        problem = await _preflight(conn)
        if problem:
            print(f"Not ready to run: {problem}")
            return 1

        observed = await conn.fetch(OBSERVE_SQL, MAX_CHANNEL_INDEX)
        resolved, notes = canonical_hashes(observed)

        print("Wire-confirmed buckets (channel names learned from encrypted uplinks):")
        for name, bucket in sorted(resolved.items()):
            print(f"  {name:20s} -> {bucket}")
        if notes:
            print("\nNot usable as targets:")
            for name, why in sorted(notes.items()):
                print(f"  {name:20s} {why}")

        total_index_rows = await conn.fetchval(
            "SELECT COUNT(*) FROM chat_messages WHERE channel_id ~ '^[0-7]$'"
        )

        # Plan: index-range rows whose name resolves somewhere else. Skipped
        # entirely when nothing is learned — a fresh upgrade has an empty map,
        # and scanning the archive to move zero rows helps nobody.
        grouped = defaultdict(list)
        unresolvable = defaultdict(int)
        rows_with_copy = 0
        if resolved and total_index_rows:
            print(f"\nScanning {total_index_rows} index-bucket chat row(s) "
                  f"against the archive...")
            copies = list(await conn.fetch(PASS1_SQL, MAX_CHANNEL_INDEX))
            await conn.execute(MISSED_TABLE_SQL)
            missed = _updated_count(
                await conn.execute(MISSED_FILL_SQL, MAX_CHANNEL_INDEX))
            if missed:
                await conn.execute("ANALYZE _bf_missed")
                copies += await conn.fetch(PASS2_SQL)
            copies.sort(key=lambda r: r["id"])
            for r in copies:
                rows_with_copy += 1
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
        elif total_index_rows:
            print(f"\nNo wire-confirmed names yet — skipping the chat pass "
                  f"({total_index_rows} index-bucket rows untouched; re-run "
                  f"after post-upgrade traffic has been ingested).")

        plan = [(n, b, t, ids) for (n, b, t), ids in grouped.items()]
        total = sum(len(ids) for *_, ids in plan)

        if unresolvable:
            print("\nLeft alone — no wire-confirmed hash for these names:")
            for name, n in sorted(unresolvable.items(), key=lambda kv: -kv[1]):
                print(f"  {n:6d}  {name}")
        print(f"\n{'Would re-file' if not args.apply else 'Re-filing'} {total} row(s):")
        for name, bucket, target, ids in sorted(plan, key=lambda p: -len(p[3])):
            print(f"  {len(ids):6d}  {name:20s} {bucket} -> {target}")

        if resolved and total_index_rows:
            stranded = total_index_rows - rows_with_copy
            if stranded:
                print(f"\n{stranded} index-bucket row(s) have no archived copy at "
                      f"all and stay where they are — unrecoverable.")

        # ── nodes.last_channel pass ──
        total_index_nodes = await conn.fetchval(
            "SELECT COUNT(*) FROM nodes WHERE last_channel ~ '^[0-7]$'"
        )
        by_target: dict = defaultdict(list)
        if total_index_nodes:
            print(f"\nScanning {total_index_nodes} index-bucket node(s) "
                  f"against the archive...")
            for r in await conn.fetch(NODE_EVIDENCE_SQL):
                by_target[(r["old_bucket"], r["new_bucket"])].append(r["id"])
        n_nodes = sum(len(v) for v in by_target.values())
        print(f"\n{'Would re-file' if not args.apply else 'Re-filing'} {n_nodes} node(s) "
              f"by their own latest hash-carrying packet:")
        for (old_b, new_b), ids in sorted(by_target.items(), key=lambda kv: -len(kv[1])):
            print(f"  {len(ids):6d}  last_channel {old_b} -> {new_b}")
        evidence_less = total_index_nodes - n_nodes
        if evidence_less:
            print(f"  {evidence_less} node(s) in index buckets have no hash-carrying "
                  f"packet at all — left alone (they heal if they ever transmit one).")

        if not total and not n_nodes:
            print("\nNothing to do.")
            return 0
        if not args.apply:
            print("\nDry run. Re-run with --apply to write. Back up the three "
                  "tables this script writes first:")
            print(BACKUP_HINT)
            return 0

        print("\nWriting (backup taken? this script writes chat_messages, "
              "chat_channels, and nodes):")
        print(BACKUP_HINT)

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
            for i in range(0, len(ids), batch):
                chunk = ids[i:i + batch]
                async with conn.transaction():
                    tag = await conn.execute(
                        "UPDATE chat_messages SET channel_id = $1 WHERE id = ANY($2::bigint[])",
                        target, chunk,
                    )
                moved += _updated_count(tag)
                print(f"  ... {moved}/{total}", end="\r", flush=True)

        moved_nodes = 0
        for (old_b, new_b), ids in by_target.items():
            for i in range(0, len(ids), batch):
                chunk = ids[i:i + batch]
                async with conn.transaction():
                    # Old-value guard: a node that transmitted between plan and
                    # write keeps its fresher ingest-stamped bucket.
                    tag = await conn.execute(
                        """
                        UPDATE nodes SET last_channel = $1
                        WHERE id = ANY($3::varchar[]) AND last_channel = $2
                        """,
                        new_b, old_b, chunk,
                    )
                moved_nodes += _updated_count(tag)

        print(f"\nDone. Re-filed {moved} chat row(s) and {moved_nodes} node(s).")
        print("Empty source buckets are left in chat_channels; the UI hides "
              "channels with no data.")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
