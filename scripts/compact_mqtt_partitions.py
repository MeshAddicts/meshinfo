#!/usr/bin/env python3
"""
Compact historical mqtt_messages partitions into deduped form (#526).

Rewrites one closed monthly partition at a time: per-gateway uplink copies of
the same mesh packet collapse into the canonical (first-heard) row, and every
copy — including the canonical one — becomes a packet_receptions row. The
transform is lossless (see storage/db/uplink_dedup.py): canonical payload text
is preserved byte-for-byte with its original row id and created_at, and each
copy is exactly reconstructible from its reception row.

This is a ONE-TIME migration for history from before the dedup deploy — months
ingested with dedup enabled are born compact and are refused here. Typical run
(inside the app container):

    python scripts/compact_mqtt_partitions.py --all --dry-run   # what would happen
    python scripts/compact_mqtt_partitions.py --all             # sweep everything eligible
    python scripts/compact_mqtt_partitions.py --month 2026_05   # or one month at a time

The old partition survives as mqtt_messages_YYYY_MM_precompact; disk is
reclaimed only when you DROP it after spot-checking (or pass --drop-original
to drop immediately after the verified swap).
"""

import argparse
import asyncio
import datetime
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import asyncpg

# Run as `python scripts/...` from the repo root or anywhere else.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage.db.uplink_dedup import (  # noqa: E402
    coerce_packet_id,
    contains_nul,
    gateway_from_msg,
    reception_fields,
    reception_patch,
    reception_template,
)
from utils import normalize_node_id  # noqa: E402

BATCH = 5000

MQTT_COLUMNS = (
    "id", "topic", "payload", "qos", "retain", "timestamp",
    "created_at", "from_node_id", "to_node_id", "packet_id",
)
RECEPTION_COLUMNS = (
    "mqtt_row_id", "created_at", "gateway", "topic_id", "rx_rssi", "rx_snr",
    "rx_time", "hop_limit", "hops_away", "relay_node", "transport", "extras",
)


def _dsn_from_config(path: Path) -> str:
    """Build a DSN from config.toml's [storage.postgres] section."""
    import tomllib

    with open(path, "rb") as f:
        pg = tomllib.load(f).get("storage", {}).get("postgres", {})
    return (
        f"postgresql://{pg.get('username', 'postgres')}:{pg.get('password', 'password')}"
        f"@{pg.get('host', 'postgres')}:{pg.get('port', 5432)}/{pg.get('database', 'meshinfo')}"
    )


def _month_bounds(month: str) -> Tuple[str, str]:
    """Half-open [lo, hi) TIMESTAMPTZ literals for a 'YYYY_MM' month."""
    start = datetime.date(int(month[:4]), int(month[5:7]), 1)
    nxt = (start + datetime.timedelta(days=32)).replace(day=1)
    return f"{start:%Y-%m-%d} 00:00:00+00", f"{nxt:%Y-%m-%d} 00:00:00+00"


class Merger:
    """Streaming merge over one partition's rows, ordered by (created_at, id).

    Mirrors ingest dedup exactly, except the window is evaluated against each
    row's historical created_at rather than wall-clock now().
    """

    def __init__(self, window_seconds: float):
        self.window = datetime.timedelta(seconds=window_seconds)
        # (from, packet_id) -> (row_id, canonical dict, canonical created_at)
        self.entries: Dict[Tuple[str, int], Tuple[int, Dict[str, Any], datetime.datetime]] = {}
        self.canonical_rows: List[tuple] = []
        self.reception_rows: List[tuple] = []  # topic string in the topic_id slot; interned on flush
        self.stats = {"source": 0, "canonical": 0, "duplicate": 0, "passthrough": 0}

    def _purge(self, now: datetime.datetime) -> None:
        expired = [k for k, (_, _, born) in self.entries.items() if born + self.window <= now]
        for k in expired:
            del self.entries[k]

    def _reception(self, row_id: int, msg: Dict[str, Any], canonical: Dict[str, Any],
                   created_at: datetime.datetime) -> Optional[tuple]:
        raw_topic = msg.get("topic")
        topic = raw_topic if isinstance(raw_topic, str) else None
        gateway = gateway_from_msg(msg)
        fields = reception_fields(msg)
        patch = reception_patch(reception_template(canonical, gateway, topic, fields), msg)
        # jsonb rejects NUL-bearing strings — signal the caller to store this copy verbatim.
        if patch is not None and contains_nul(patch):
            return None
        extras = json.dumps(patch) if patch else None
        return (
            row_id, created_at, gateway, topic,
            fields["rx_rssi"], fields["rx_snr"], fields["rx_time"],
            fields["hop_limit"], fields["hops_away"], fields["relay_node"],
            fields["transport"], extras,
        )

    def _emit_canonical(self, row, packet_id: Optional[int]) -> None:
        """One staging tuple in MQTT_COLUMNS order, with the recomputed packet_id."""
        self.canonical_rows.append(tuple(row[c] for c in MQTT_COLUMNS[:-1]) + (packet_id,))

    def _passthrough(self, row, packet_id: Optional[int]) -> None:
        self.stats["passthrough"] += 1
        self._emit_canonical(row, packet_id)

    def feed(self, row) -> None:
        self.stats["source"] += 1
        created_at = row["created_at"]
        if self.stats["source"] % (BATCH * 4) == 0:
            self._purge(created_at)

        payload_text = row["payload"]
        msg: Optional[Dict[str, Any]] = None
        if payload_text and payload_text.lstrip().startswith("{"):
            try:
                parsed = json.loads(payload_text)
                if isinstance(parsed, dict):
                    msg = parsed
            except (json.JSONDecodeError, TypeError):
                msg = None

        packet_id = coerce_packet_id(msg.get("id")) if msg else None
        from_node_id = row["from_node_id"] or (normalize_node_id(msg.get("from")) if msg else None)
        if msg is None or packet_id is None or not from_node_id:
            self._passthrough(row, packet_id)
            return

        key = (from_node_id, packet_id)
        entry = self.entries.get(key)
        if entry is not None and entry[2] + self.window > created_at:
            reception = self._reception(entry[0], msg, entry[1], created_at)
            if reception is None:
                self._passthrough(row, packet_id)
                return
            self.stats["duplicate"] += 1
            self.reception_rows.append(reception)
            return

        reception = self._reception(row["id"], msg, msg, created_at)
        if reception is None:
            self._passthrough(row, packet_id)
            return
        self.stats["canonical"] += 1
        self._emit_canonical(row, packet_id)
        self.reception_rows.append(reception)
        self.entries[key] = (row["id"], msg, created_at)


async def _intern_topics(conn: asyncpg.Connection, receptions: List[tuple],
                         cache: Dict[str, int]) -> List[tuple]:
    """Replace each buffered reception's topic string with its mqtt_topics id."""
    out = []
    for r in receptions:
        topic = r[3]
        tid = None
        if topic:
            tid = cache.get(topic)
            if tid is None:
                tid = await conn.fetchval(
                    "INSERT INTO mqtt_topics (topic) VALUES ($1) "
                    "ON CONFLICT (topic) DO UPDATE SET topic = EXCLUDED.topic RETURNING id",
                    topic,
                )
                cache[topic] = tid
        out.append(r[:3] + (tid,) + r[4:])
    return out


async def find_eligible_months(conn: asyncpg.Connection) -> List[str]:
    """Pre-dedup mqtt_messages partition months, oldest first. A month is
    pre-dedup iff it has no packet_receptions partition (ingest-era months get
    one live; compacted months get one from the rewrite), no *_precompact
    leftover awaiting review, and is not the current month. compact_month
    re-checks everything — this is just discovery for --all."""
    now_month = (await conn.fetchval("SELECT (now() AT TIME ZONE 'UTC')::date")).strftime("%Y_%m")
    rows = await conn.fetch(
        r"""SELECT c.relname FROM pg_class c
            JOIN pg_inherits i ON i.inhrelid = c.oid
            WHERE i.inhparent = 'mqtt_messages'::regclass
              AND c.relname ~ '^mqtt_messages_\d{4}_\d{2}$'"""
    )
    months = []
    for r in rows:
        month = r["relname"][len("mqtt_messages_"):]
        if month >= now_month:
            continue
        if await conn.fetchval("SELECT to_regclass($1)", f"packet_receptions_{month}"):
            continue
        if await conn.fetchval("SELECT to_regclass($1)", f"mqtt_messages_{month}_precompact"):
            print(f"[{month}] skipping: leftover mqtt_messages_{month}_precompact needs review")
            continue
        months.append(month)
    return sorted(months)


async def compact_month(conn: asyncpg.Connection, month: str, window: float,
                        dry_run: bool, force_wipe: bool,
                        drop_original: bool = False) -> bool:
    part = f"mqtt_messages_{month}"
    staging = f"{part}_compact"
    old = f"{part}_precompact"
    recv_part = f"packet_receptions_{month}"
    lo, hi = _month_bounds(month)

    # ── preconditions ──────────────────────────────────────────────────
    now_month = (await conn.fetchval("SELECT (now() AT TIME ZONE 'UTC')::date")).strftime("%Y_%m")
    if month >= now_month:
        print(f"[{month}] refusing: only closed months can be compacted (current: {now_month})")
        return False
    is_partition = await conn.fetchval(
        "SELECT count(*) FROM pg_inherits WHERE inhrelid = to_regclass($1) "
        "AND inhparent = 'mqtt_messages'::regclass", part)
    if not is_partition:
        print(f"[{month}] refusing: {part} is not an attached partition of mqtt_messages")
        return False
    if await conn.fetchval("SELECT to_regclass($1)", old):
        print(f"[{month}] refusing: {old} already exists — previous run needs review/DROP first")
        return False
    # Dedup-era rows carry packet_id and already have live packet_receptions —
    # compacting (and especially --force-wipe-receptions) would destroy them.
    # This script is strictly for pre-dedup history.
    if await conn.fetchval(f"SELECT 1 FROM {part} WHERE packet_id IS NOT NULL LIMIT 1"):
        print(f"[{month}] refusing: {part} contains dedup-era rows (packet_id set) — "
              "it is already deduplicated or mixed; compaction only applies to pre-dedup months")
        return False

    src_count = await conn.fetchval(f"SELECT count(*) FROM {part}")
    src_bytes = await conn.fetchval("SELECT pg_total_relation_size($1)", part)
    print(f"[{month}] source: {src_count} rows, {src_bytes / 1e9:.2f} GB (incl. indexes)")

    # ── merge (streaming, sorted so the window matches ingest behavior) ──
    merger = Merger(window)
    topic_cache: Dict[str, int] = {}

    await conn.execute(f"DROP TABLE IF EXISTS {staging}")
    await conn.execute(
        f"CREATE TABLE {staging} (LIKE mqtt_messages INCLUDING DEFAULTS INCLUDING STORAGE)")

    if not dry_run:
        # A fresh receptions partition for the month; compaction is its only writer.
        exists = await conn.fetchval("SELECT to_regclass($1)", recv_part)
        if exists is None:
            await conn.execute(
                f"CREATE TABLE {recv_part} PARTITION OF packet_receptions "
                f"FOR VALUES FROM (TIMESTAMPTZ '{lo}') TO (TIMESTAMPTZ '{hi}')")
        elif await conn.fetchval(f"SELECT count(*) FROM {recv_part}") > 0:
            if not force_wipe:
                print(f"[{month}] refusing: {recv_part} is not empty (use --force-wipe-receptions "
                      "if a previous compaction attempt left partial rows)")
                await conn.execute(f"DROP TABLE {staging}")
                return False
            await conn.execute(f"TRUNCATE {recv_part}")

    async def flush() -> None:
        if dry_run:
            merger.canonical_rows.clear()
            merger.reception_rows.clear()
            return
        if merger.canonical_rows:
            await conn.copy_records_to_table(staging, records=merger.canonical_rows,
                                             columns=MQTT_COLUMNS)
            merger.canonical_rows.clear()
        if merger.reception_rows:
            records = await _intern_topics(conn, merger.reception_rows, topic_cache)
            await conn.copy_records_to_table(recv_part, records=records,
                                             columns=RECEPTION_COLUMNS)
            merger.reception_rows.clear()

    async with conn.transaction():
        async for row in conn.cursor(
            f"SELECT {', '.join(MQTT_COLUMNS)} FROM {part} ORDER BY created_at, id",
            prefetch=BATCH,
        ):
            merger.feed(row)
            if len(merger.canonical_rows) + len(merger.reception_rows) >= BATCH:
                await flush()
        await flush()

    s = merger.stats
    kept = s["canonical"] + s["passthrough"]
    print(f"[{month}] merged: {s['source']} copies -> {kept} rows "
          f"({s['canonical']} canonical + {s['passthrough']} passthrough) "
          f"+ {s['canonical'] + s['duplicate']} receptions")

    # ── verify ────────────────────────────────────────────────────────
    if s["source"] != src_count:
        print(f"[{month}] ABORT: streamed {s['source']} rows but partition has {src_count}")
        await conn.execute(f"DROP TABLE {staging}")
        return False
    if dry_run:
        await conn.execute(f"DROP TABLE {staging}")
        print(f"[{month}] dry run complete — nothing written")
        return True
    staging_count = await conn.fetchval(f"SELECT count(*) FROM {staging}")
    recv_count = await conn.fetchval(f"SELECT count(*) FROM {recv_part}")
    if staging_count != kept or recv_count != s["canonical"] + s["duplicate"]:
        print(f"[{month}] ABORT: verify mismatch (staging {staging_count}, receptions {recv_count})")
        await conn.execute(f"DROP TABLE {staging}")
        return False

    # ── swap ──────────────────────────────────────────────────────────
    # The CHECK constraint lets ATTACH skip its full-partition validation scan.
    await conn.execute(
        f"ALTER TABLE {staging} ADD CONSTRAINT {staging}_range CHECK "
        f"(created_at >= TIMESTAMPTZ '{lo}' AND created_at < TIMESTAMPTZ '{hi}')")
    async with conn.transaction():
        await conn.execute(f"ALTER TABLE mqtt_messages DETACH PARTITION {part}")
        await conn.execute(f"ALTER TABLE {part} RENAME TO {old}")
        await conn.execute(f"ALTER TABLE {staging} RENAME TO {part}")
        await conn.execute(
            f"ALTER TABLE mqtt_messages ATTACH PARTITION {part} "
            f"FOR VALUES FROM (TIMESTAMPTZ '{lo}') TO (TIMESTAMPTZ '{hi}')")
    await conn.execute(f"ANALYZE {part}")

    new_bytes = await conn.fetchval("SELECT pg_total_relation_size($1)", part)
    recv_bytes = await conn.fetchval("SELECT pg_total_relation_size($1)", recv_part)
    if drop_original:
        # Counts were verified above and the swap committed — reclaim now.
        await conn.execute(f"DROP TABLE {old}")
        print(f"[{month}] done: {src_bytes / 1e9:.2f} GB -> "
              f"{(new_bytes + recv_bytes) / 1e9:.2f} GB; original dropped.")
    else:
        print(f"[{month}] done: {src_bytes / 1e9:.2f} GB -> "
              f"{(new_bytes + recv_bytes) / 1e9:.2f} GB. Old data kept as {old}; "
              f"reclaim with: DROP TABLE {old};")
    return True


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--month", action="append",
                    help="partition month YYYY_MM (repeatable)")
    ap.add_argument("--all", action="store_true",
                    help="discover and compact every eligible pre-dedup month (oldest first)")
    ap.add_argument("--dsn", help="postgres DSN (default: from --config)")
    ap.add_argument("--config", default=str(Path(__file__).resolve().parents[1] / "config.toml"))
    ap.add_argument("--window-seconds", type=float, default=900.0,
                    help="dedup window, match storage.dedup_window_seconds (default 900)")
    ap.add_argument("--dry-run", action="store_true", help="report counts, write nothing")
    ap.add_argument("--force-wipe-receptions", action="store_true",
                    help="TRUNCATE the month's packet_receptions partition left by an aborted run")
    ap.add_argument("--drop-original", action="store_true",
                    help="DROP the *_precompact original after the verified swap (reclaims disk)")
    args = ap.parse_args()
    if bool(args.month) == args.all:
        print("pass either --month YYYY_MM or --all")
        return 2

    dsn = args.dsn or _dsn_from_config(Path(args.config))
    conn = await asyncpg.connect(dsn)
    try:
        months = args.month or await find_eligible_months(conn)
        if not months:
            print("nothing eligible: every closed month is already in dedup format")
            return 0
        ok = True
        for month in months:
            if len(month) != 7 or month[4] != "_" or not (month[:4] + month[5:7]).isdigit() \
                    or not 1 <= int(month[5:7]) <= 12:
                print(f"bad --month {month!r}: expected YYYY_MM")
                return 2
            ok = await compact_month(conn, month, args.window_seconds,
                                     args.dry_run, args.force_wipe_receptions,
                                     drop_original=args.drop_original) and ok
        return 0 if ok else 1
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
