"""Real-database tests for storage/db/tiering.py, gated on BOTH
MESHINFO_TIERING_TEST_DSN and MESHINFO_TIERING_TEST_TABLESPACE (a disposable
PostgreSQL with the meshinfo schema applied plus a second tablespace):

    MESHINFO_TIERING_TEST_DSN=postgresql://postgres:password@127.0.0.1:55432/meshinfo \\
    MESHINFO_TIERING_TEST_TABLESPACE=meshinfo_cold \\
    python -m pytest -q tests/test_tiering_integration.py

Every scenario creates the far-past months 2025_01 and 2025_02 for both
archive tables (the DDL ensure_mqtt_partitions uses), fills them through the
PARENT tables so the node-id trigger runs, and drops them again in `finally`
together with any *_tiering* leftover it produced, verifying the database is
back to its previous state. Live partitions are only ever used to assert a
refusal; nothing but the synthetic months is moved."""

import asyncio
import dataclasses
import datetime
import json
import os
import time
from typing import Dict, List, Optional, Tuple

import asyncpg
import pytest

from storage.db.tiering import (
    COPY_LOCK_TIMEOUT,
    OLD_SUFFIX,
    SCRATCH_SUFFIX,
    TIERABLE_TABLES,
    PartitionInfo,
    TieringBusy,
    TieringPolicy,
    TieringRefused,
    add_months,
    cold_cutoff,
    db_now,
    default_tablespace,
    ensure_cold_tablespace,
    is_cold,
    list_partitions,
    month_bounds,
    month_label,
    move_partition,
    plan,
    run_cycle,
    safe_name,
    set_session,
    tablespace_exists,
    timeout_seconds,
)

DSN = os.environ.get("MESHINFO_TIERING_TEST_DSN", "")
TABLESPACE = os.environ.get("MESHINFO_TIERING_TEST_TABLESPACE", "")

pytestmark = pytest.mark.skipif(
    not (DSN and TABLESPACE),
    reason="MESHINFO_TIERING_TEST_DSN / MESHINFO_TIERING_TEST_TABLESPACE not set",
)

UTC = datetime.timezone.utc
JAN = datetime.date(2025, 1, 1)
FEB = datetime.date(2025, 2, 1)
MONTHS = (JAN, FEB)


def _part(table: str, month: datetime.date) -> str:
    return f"{table}_{month_label(month)}"


MQTT_JAN, RECV_JAN = _part("mqtt_messages", JAN), _part("packet_receptions", JAN)
MQTT_FEB, RECV_FEB = _part("mqtt_messages", FEB), _part("packet_receptions", FEB)
SYNTHETIC = (MQTT_JAN, RECV_JAN, MQTT_FEB, RECV_FEB)
SYNTHETIC_PREFIXES = tuple(f"{t}_2025_" for t in TIERABLE_TABLES)

# Live ids are BIGSERIAL from 1 and test_postgres_integration uses 9.1e18:
# synthetic rows can collide with neither.
SYNTH_ID_BASE = 9_200_000_000_000_000
ROWS_PER_MONTH = 120
NON_JSON_EVERY = 10  # every 10th payload is not JSON: its from_node_id stays NULL for good

POLICY = TieringPolicy(cold_after_months=3, cold_tablespace=TABLESPACE)
TRIGGER = "trg_mqtt_messages_extract_node_ids"

_DEFAULT_TS_SQL = (
    "(SELECT d.spcname FROM pg_tablespace d WHERE d.oid = "
    "(SELECT dattablespace FROM pg_database WHERE datname = current_database()))"
)
_INDEX_LAYOUT_SQL = f"""
SELECT ic.relname AS idx, pc.relname AS parent_idx,
       COALESCE(ts.spcname, {_DEFAULT_TS_SQL}) AS tablespace
FROM pg_index ix
JOIN pg_class ic ON ic.oid = ix.indexrelid
LEFT JOIN pg_inherits ih ON ih.inhrelid = ic.oid
LEFT JOIN pg_class pc ON pc.oid = ih.inhparent
LEFT JOIN pg_tablespace ts ON ts.oid = ic.reltablespace
WHERE ix.indrelid = to_regclass($1)
ORDER BY 1
"""
_TOAST_TS_SQL = f"""
SELECT COALESCE(ts.spcname, {_DEFAULT_TS_SQL})
FROM pg_class c
JOIN pg_class t ON t.oid = c.reltoastrelid
LEFT JOIN pg_tablespace ts ON ts.oid = t.reltablespace
WHERE c.oid = to_regclass($1)
"""
_TIERING_RELATIONS_SQL = "SELECT relname FROM pg_class WHERE relname LIKE '%\\_tiering%' ORDER BY 1"
_TIERING_TABLES_SQL = (
    "SELECT relname FROM pg_class WHERE relname LIKE '%\\_tiering%' AND relkind IN ('r', 'p') ORDER BY 1"
)
_TIERING_CONSTRAINTS_SQL = "SELECT conname FROM pg_constraint WHERE conname LIKE '%\\_tiering%' ORDER BY 1"
_SYNTHETIC_PARTITIONS_SQL = """
SELECT c.relname
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent IN (to_regclass('mqtt_messages'), to_regclass('packet_receptions'))
  AND c.relname LIKE '%\\_2025\\_%'
ORDER BY 1
"""


# ----------------------------------------------------------------------------
# Synthetic months: create, fill through the parents, drop
# ----------------------------------------------------------------------------

async def _connect() -> asyncpg.Connection:
    conn = await asyncpg.connect(DSN, command_timeout=None)
    await set_session(conn)
    return conn


def _table_of(name: str) -> str:
    return next(t for t in TIERABLE_TABLES if name.startswith(t + "_"))


def _row_id(month: datetime.date, i: int) -> int:
    return SYNTH_ID_BASE + (month.year * 12 + month.month) * 1_000_000 + i


async def _create_partitions(conn: asyncpg.Connection, months=MONTHS) -> None:
    """Same DDL as PostgresStorage.ensure_mqtt_partitions."""
    for month in months:
        lo, hi = month_bounds(month)
        for table in TIERABLE_TABLES:
            await conn.execute(
                f"CREATE TABLE IF NOT EXISTS {_part(table, month)} "
                f"PARTITION OF {table} "
                f"FOR VALUES FROM (TIMESTAMPTZ '{lo:%Y-%m-%d} 00:00:00+00') "
                f"TO (TIMESTAMPTZ '{hi:%Y-%m-%d} 00:00:00+00')"
            )


def _synthetic_rows(month: datetime.date) -> Tuple[List[tuple], List[tuple]]:
    """(mqtt rows, reception rows) for one month. JSON payloads carry from/to/id
    so the node-id trigger fills from_node_id/to_node_id/packet_id; every
    NON_JSON_EVERY-th payload is raw text whose from_node_id stays NULL exactly
    like legacy rows the backfill can never fix; pairs of rows share a
    created_at so ORDER BY created_at, id is what fixes their order."""
    lo, _ = month_bounds(month)
    mqtt: List[tuple] = []
    receptions: List[tuple] = []
    for i in range(ROWS_PER_MONTH):
        row_id = _row_id(month, i)
        created = lo + datetime.timedelta(minutes=37 * (i // 2))
        node = 0xABCDEF00 + i % 7
        if i % NON_JSON_EVERY == NON_JSON_EVERY - 1:
            payload = f"raw-uplink-not-json-{i}"
        else:
            payload = json.dumps({
                "from": node, "to": 0xFFFFFFFF, "id": 4_000_000_000 + i, "type": "text",
                "payload": {"text": f"synthetic tiering row {i}"},
            })
        preset = "e" if i % 3 else "json"  # '/2/e/' topics hit the preset_split partial index
        topic = f"msh/US/2/{preset}/LongFast/!{node:08x}"
        mqtt.append((row_id, topic, payload, 0, False, int(created.timestamp()), created))
        for copy in range(1 + i % 3):
            receptions.append((
                row_id, created, f"beef{copy:04x}", 1 + copy, -90 - copy, 5.5 - copy,
                int(created.timestamp()), 3, copy, None, 1,
                json.dumps({"synthetic": True, "copy": copy}),
            ))
    return mqtt, receptions


async def _fill(conn: asyncpg.Connection, months=MONTHS) -> None:
    for month in months:
        mqtt, receptions = _synthetic_rows(month)
        await conn.executemany(
            "INSERT INTO mqtt_messages (id, topic, payload, qos, retain, timestamp, created_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7)",
            mqtt,
        )
        await conn.executemany(
            "INSERT INTO packet_receptions (mqtt_row_id, created_at, gateway, topic_id, rx_rssi, rx_snr, "
            "rx_time, hop_limit, hops_away, relay_node, transport, extras) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
            receptions,
        )


def _ours(name: str) -> bool:
    """Only objects derived from THIS file's synthetic months count: a shared
    test database may hold other far-past partitions we must neither trip over
    nor drop."""
    return any(name == base or name.startswith(base + "_") for base in SYNTHETIC)


async def _tiering_relations(conn: asyncpg.Connection) -> List[str]:
    return [r["relname"] for r in await conn.fetch(_TIERING_RELATIONS_SQL) if _ours(r["relname"])]


async def _tiering_constraints(conn: asyncpg.Connection) -> List[str]:
    return [r["conname"] for r in await conn.fetch(_TIERING_CONSTRAINTS_SQL) if _ours(r["conname"])]


async def _scratch_objects(conn: asyncpg.Connection, *, allow_old: bool = False) -> List[str]:
    """Relations and constraints named like tiering scratch objects; with
    allow_old the detached original's *_tiering_old family is tolerated."""
    names = await _tiering_relations(conn) + await _tiering_constraints(conn)
    if allow_old:
        names = [n for n in names if not n.endswith(OLD_SUFFIX)]
    return names


async def _synthetic_partitions(conn: asyncpg.Connection) -> List[str]:
    return [r["relname"] for r in await conn.fetch(_SYNTHETIC_PARTITIONS_SQL) if _ours(r["relname"])]


async def _cleanup(conn: asyncpg.Connection) -> None:
    """Drop the synthetic partitions and every scratch/old relation derived from
    them, then verify the database is back to its pre-test state."""
    await conn.execute("SET lock_timeout = '30s'")
    for name in SYNTHETIC:
        for rel in (name, safe_name(name, SCRATCH_SUFFIX), safe_name(name, OLD_SUFFIX)):
            await conn.execute(f'DROP TABLE IF EXISTS "{rel}"')
    for rel in (r["relname"] for r in await conn.fetch(_TIERING_TABLES_SQL)):
        if _ours(rel):
            await conn.execute(f'DROP TABLE IF EXISTS "{rel}"')
    # Synthetic rows whose month has no partition can only sit in the default partitions.
    floor = datetime.datetime(2026, 1, 1, tzinfo=UTC)
    await conn.execute(
        "DELETE FROM mqtt_messages WHERE id >= $1 AND created_at < $2", SYNTH_ID_BASE, floor)
    await conn.execute(
        "DELETE FROM packet_receptions WHERE mqtt_row_id >= $1 AND created_at < $2", SYNTH_ID_BASE, floor)
    assert await _scratch_objects(conn) == [], "tiering leftovers survived cleanup"
    assert await _synthetic_partitions(conn) == [], "synthetic partitions survived cleanup"


def _run(scenario, *args) -> None:
    """asyncio.run() one scenario against freshly created synthetic months.
    Cleanup runs on its own connection after the scenario's connection is
    closed, so a lock the scenario still holds can never block the DROPs."""

    async def main() -> None:
        conn = await _connect()
        try:
            assert await tablespace_exists(conn, TABLESPACE), f"tablespace {TABLESPACE!r} does not exist"
            assert await _scratch_objects(conn) == [], "stale *_tiering objects before the test"
            assert await _synthetic_partitions(conn) == [], "stale synthetic partitions before the test"
            await _create_partitions(conn)
            await _fill(conn)
            await scenario(conn, *args)
        finally:
            await conn.close()
            cleaner = await _connect()
            try:
                await _cleanup(cleaner)
            finally:
                await cleaner.close()

    asyncio.run(main())


# ----------------------------------------------------------------------------
# Catalog probes
# ----------------------------------------------------------------------------

async def _partition(conn: asyncpg.Connection, name: str) -> PartitionInfo:
    table = _table_of(name)
    for p in await list_partitions(conn, table):
        if p.name == name:
            return p
    raise AssertionError(f"{name} is not a partition of {table}")


async def _digest(conn: asyncpg.Connection, table: str, month: datetime.date) -> Tuple[int, Optional[str]]:
    """(row count, md5 of every row in (created_at, id) order) read THROUGH the parent."""
    lo, hi = month_bounds(month)
    order = "created_at, id" if table == "mqtt_messages" else "created_at, mqtt_row_id, gateway"
    row = await conn.fetchrow(
        f"SELECT count(*) AS n, md5(string_agg(t::text, '|' ORDER BY {order})) AS digest "
        f"FROM {table} t WHERE created_at >= $1 AND created_at < $2",
        lo, hi,
    )
    return int(row["n"]), row["digest"]


async def _index_layout(conn: asyncpg.Connection, name: str) -> Dict[str, Tuple[Optional[str], str]]:
    """index relname -> (parent partitioned index it is attached to, tablespace)."""
    rows = await conn.fetch(_INDEX_LAYOUT_SQL, name)
    return {r["idx"]: (r["parent_idx"], r["tablespace"]) for r in rows}


async def _parent_indexes(conn: asyncpg.Connection, table: str) -> set:
    rows = await conn.fetch(
        "SELECT ic.relname FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid "
        "WHERE ix.indrelid = to_regclass($1)", table)
    return {r["relname"] for r in rows}


async def _primary_key(conn: asyncpg.Connection, name: str) -> Optional[dict]:
    row = await conn.fetchrow(
        "SELECT conname, conparentid::bigint AS conparentid, pg_get_constraintdef(oid) AS condef "
        "FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'p'", name)
    return dict(row) if row else None


async def _trigger_clone(conn: asyncpg.Connection, name: str) -> Optional[dict]:
    row = await conn.fetchrow(
        "SELECT tgenabled::text AS enabled, tgparentid::bigint AS parent FROM pg_trigger "
        "WHERE tgrelid = to_regclass($1) AND tgname = $2 AND NOT tgisinternal", name, TRIGGER)
    return dict(row) if row else None


async def _bound(conn: asyncpg.Connection, name: str) -> Optional[str]:
    return await conn.fetchval(
        "SELECT pg_get_expr(relpartbound, oid) FROM pg_class WHERE oid = to_regclass($1)", name)


async def _is_attached(conn: asyncpg.Connection, name: str, table: str) -> bool:
    return bool(await conn.fetchval(
        "SELECT 1 FROM pg_inherits WHERE inhrelid = to_regclass($1) AND inhparent = to_regclass($2)",
        name, table))


async def _assert_layout(conn: asyncpg.Connection, name: str, tablespace: str, *,
                         indexes_before: Dict[str, Tuple[Optional[str], str]],
                         allow_old: bool = False) -> PartitionInfo:
    """A partition (re)built by a move: attached, entirely on tablespace (TOAST
    included), the same index names attached to the same parent partitioned
    indexes, PK constraint + trigger clone for mqtt_messages, no scratch objects."""
    table = _table_of(name)
    part = await _partition(conn, name)
    assert part.is_monthly()
    assert part.tablespace == tablespace
    assert part.on_tablespace(tablespace) and not part.partial(), sorted(part.tablespaces())
    assert await _is_attached(conn, name, table)
    layout = await _index_layout(conn, name)
    assert set(layout) == set(indexes_before), "index names not restored"
    for idx, (parent_idx, ts) in layout.items():
        assert parent_idx is not None, f"{idx} is not attached to a parent index"
        assert parent_idx == indexes_before[idx][0], idx
        assert ts == tablespace, (idx, ts)
    assert {parent for parent, _ in layout.values()} == await _parent_indexes(conn, table)
    assert part.index_tablespaces == {idx: tablespace for idx in layout}
    toast = await conn.fetchval(_TOAST_TS_SQL, name)
    assert toast in (None, tablespace), toast
    if table == "mqtt_messages":
        pk = await _primary_key(conn, name)
        assert pk is not None, "PRIMARY KEY constraint missing"
        assert pk["conname"] == f"{name}_pkey"
        assert pk["condef"] == "PRIMARY KEY (id, created_at)"
        assert pk["conparentid"] != 0, "PK constraint not attached to the parent's"
        trigger = await _trigger_clone(conn, name)
        assert trigger is not None, f"{TRIGGER} clone missing on {name}"
        assert trigger["enabled"] == "O" and trigger["parent"] != 0, trigger
    assert await _scratch_objects(conn, allow_old=allow_old) == []
    return part


# ----------------------------------------------------------------------------
# Scenarios
# ----------------------------------------------------------------------------

def test_full_move_to_cold_with_deep_verify():
    """2025_01 (both tables) -> cold tablespace with deep verification: rows and
    order through the parent unchanged, index names restored and attached, PK
    and trigger clone present, no scratch objects; a second move is a no-op."""
    _run(_full_move_scenario)


async def _full_move_scenario(conn: asyncpg.Connection) -> None:
    default_ts = await default_tablespace(conn)
    before = {}
    for name in (MQTT_JAN, RECV_JAN):
        table = _table_of(name)
        part = await _partition(conn, name)
        assert part.is_monthly() and part.label() == "2025_01" and part.month == JAN
        assert (part.lo, part.hi) == month_bounds(JAN)
        assert part.on_tablespace(default_ts) and not part.partial()
        assert part.total_bytes > 0
        layout = await _index_layout(conn, name)
        assert {parent for parent, _ in layout.values()} == await _parent_indexes(conn, table)
        before[name] = (part, layout, await _digest(conn, table, JAN), await _bound(conn, name))
    assert before[MQTT_JAN][2][0] == ROWS_PER_MONTH
    assert before[RECV_JAN][2][0] > ROWS_PER_MONTH
    # Non-JSON payloads keep from_node_id NULL forever; they must not count as "backfill pending".
    assert await conn.fetchval(
        f"SELECT count(*) FROM {MQTT_JAN} WHERE from_node_id IS NULL") == ROWS_PER_MONTH // NON_JSON_EVERY

    cycle = await run_cycle(conn, POLICY, only=[MQTT_JAN, RECV_JAN], deep_verify=True, max_partitions=0)

    assert [r.status for r in cycle.results] == ["moved", "moved"]
    assert (cycle.moved, cycle.skipped, cycle.refused, cycle.busy, cycle.failed) == (2, 0, 0, 0, 0)
    assert cycle.target == TABLESPACE and cycle.dry_run is False
    assert "moved" in cycle.summary()
    json.dumps(cycle.as_dict())  # JSON-friendly for the CLI
    for res in cycle.results:
        part0, layout0, (count0, digest0), bound0 = before[res.partition]
        assert (res.table, res.month, res.target) == (part0.table, JAN, TABLESPACE)
        assert res.rows == count0
        assert res.indexes == len(layout0)
        assert res.deep_verified is True
        assert res.kept_original is None
        assert res.swap_attempts == 1
        assert res.bytes_before > 0 and res.bytes_after > 0
        assert res.seconds >= 0
        assert res.vacuumed is True, "post-move VACUUM (FREEZE, ANALYZE) did not run"
        assert await conn.fetchval(
            "SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass($1)", res.partition) == res.rows
        assert await conn.fetchval(
            "SELECT age(relfrozenxid) < 1000 FROM pg_class WHERE oid = to_regclass($1)", res.partition)
        rebuilt = await _assert_layout(conn, res.partition, TABLESPACE, indexes_before=layout0)
        assert rebuilt.oid != part0.oid
        assert await _bound(conn, res.partition) == bound0
        assert await _digest(conn, res.table, JAN) == (count0, digest0)
    assert not conn.is_in_transaction()

    # Second move: already on the target -> "skipped", nothing touched.
    again = await run_cycle(conn, POLICY, only=[MQTT_JAN, RECV_JAN], deep_verify=True, max_partitions=0)
    assert [r.status for r in again.results] == ["skipped", "skipped"]
    assert again.skipped == 2 and again.moved == 0
    assert all("already on" in r.reason for r in again.results)
    direct = await move_partition(conn, await _partition(conn, MQTT_JAN), TABLESPACE, policy=POLICY)
    assert direct.status == "skipped"
    for name in (MQTT_JAN, RECV_JAN):
        part0, layout0, snapshot0, _ = before[name]
        await _assert_layout(conn, name, TABLESPACE, indexes_before=layout0)
        assert await _digest(conn, _table_of(name), JAN) == snapshot0


def test_targeted_cycle_keep_original_leaves_detached_copy():
    """run_cycle(only=[...], keep_original=True) moves the named partition and
    leaves the original detached as <part>_tiering_old (indexes renamed with
    it); an unknown name is refused; the leftover blocks a further move until
    it is dropped."""
    _run(_keep_original_scenario)


async def _keep_original_scenario(conn: asyncpg.Connection) -> None:
    default_ts = await default_tablespace(conn)
    part0 = await _partition(conn, MQTT_FEB)
    layout0 = await _index_layout(conn, MQTT_FEB)
    snapshot0 = await _digest(conn, "mqtt_messages", FEB)
    old = safe_name(MQTT_FEB, OLD_SUFFIX)
    assert old == f"{MQTT_FEB}_tiering_old"

    # The unknown name comes first: the policy cap (1 per cycle) counts moves only.
    cycle = await run_cycle(conn, POLICY, only=["mqtt_messages_1999_12", MQTT_FEB], keep_original=True)

    assert [r.status for r in cycle.results] == ["refused", "moved"]
    unknown, moved = cycle.results
    assert unknown.partition == "mqtt_messages_1999_12" and "not a partition" in unknown.reason
    assert moved.partition == MQTT_FEB and moved.rows == snapshot0[0]
    assert moved.kept_original == old
    assert cycle.refused == 1 and cycle.moved == 1

    # The detached original: no bound, not a child of the parent, still on its old
    # tablespace with every row and its indexes (and PK constraint) renamed aside.
    assert await conn.fetchval("SELECT to_regclass($1)::text", old) == old
    assert not await _is_attached(conn, old, "mqtt_messages")
    assert await _bound(conn, old) is None
    assert await conn.fetchval(f'SELECT count(*) FROM "{old}"') == snapshot0[0]
    old_layout = await _index_layout(conn, old)
    assert set(old_layout) == {safe_name(idx, OLD_SUFFIX) for idx in layout0}
    assert all(parent is None and ts == default_ts for parent, ts in old_layout.values())
    old_pk = await _primary_key(conn, old)
    assert old_pk is not None and old_pk["conname"] == safe_name(f"{MQTT_FEB}_pkey", OLD_SUFFIX)

    # The live partition is the rebuilt copy on the cold tablespace, reading the same data.
    rebuilt = await _assert_layout(conn, MQTT_FEB, TABLESPACE, indexes_before=layout0, allow_old=True)
    assert rebuilt.oid != part0.oid
    assert await _digest(conn, "mqtt_messages", FEB) == snapshot0
    assert (await _partition(conn, RECV_FEB)).on_tablespace(default_ts)  # the untargeted sibling stays put

    # The leftover must be reviewed and dropped by an operator before any further move.
    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, await _partition(conn, MQTT_FEB), default_ts, policy=POLICY)
    assert "leftover" in str(excinfo.value) and old in str(excinfo.value)
    assert (await _partition(conn, MQTT_FEB)).oid == rebuilt.oid

    await conn.execute(f'DROP TABLE "{old}"')
    assert await _scratch_objects(conn) == []
    back = await move_partition(conn, await _partition(conn, MQTT_FEB), default_ts, policy=POLICY)
    assert back.status == "moved" and back.kept_original is None
    await _assert_layout(conn, MQTT_FEB, default_ts, indexes_before=layout0)
    assert await _digest(conn, "mqtt_messages", FEB) == snapshot0


def test_inserts_through_parent_route_into_moved_partition():
    """After the move the parent still routes 2025_01 rows into the rebuilt
    partition, the trigger clone fills node ids and the rebuilt PK enforces."""
    _run(_routing_scenario)


async def _routing_scenario(conn: asyncpg.Connection) -> None:
    cycle = await run_cycle(conn, POLICY, only=[MQTT_JAN, RECV_JAN], max_partitions=0)
    assert [r.status for r in cycle.results] == ["moved", "moved"]
    lo, hi = month_bounds(JAN)
    created = lo + datetime.timedelta(days=20, hours=3)
    row_id = _row_id(JAN, 500_000)
    payload = json.dumps({"from": 0xABCDEF42, "to": 0xFFFFFFFF, "id": 4_200_000_000, "type": "text"})

    await conn.execute(
        "INSERT INTO mqtt_messages (id, topic, payload, created_at) VALUES ($1, $2, $3, $4)",
        row_id, "msh/US/2/e/LongFast/!abcdef42", payload, created)
    row = await conn.fetchrow(
        "SELECT tableoid::regclass::text AS rel, from_node_id, to_node_id, packet_id "
        "FROM mqtt_messages WHERE id = $1", row_id)
    assert row["rel"] == MQTT_JAN
    assert (row["from_node_id"], row["to_node_id"], row["packet_id"]) == ("abcdef42", "ffffffff", 4_200_000_000)
    assert await conn.fetchval(f"SELECT count(*) FROM {MQTT_JAN} WHERE id = $1", row_id) == 1
    with pytest.raises(asyncpg.exceptions.UniqueViolationError):
        await conn.execute(
            "INSERT INTO mqtt_messages (id, topic, payload, created_at) VALUES ($1, $2, $3, $4)",
            row_id, "msh/US/2/e/LongFast/!abcdef42", payload, created)

    await conn.execute(
        "INSERT INTO packet_receptions (mqtt_row_id, created_at, gateway, extras) VALUES ($1, $2, $3, $4)",
        row_id, created, "beefcafe", json.dumps({"synthetic": True}))
    assert await conn.fetchval(
        "SELECT tableoid::regclass::text FROM packet_receptions WHERE mqtt_row_id = $1", row_id) == RECV_JAN

    # Parent-level reads (and their partition pruning) see the row in the moved month.
    assert await conn.fetchval(
        "SELECT count(*) FROM mqtt_messages WHERE from_node_id = $1 AND created_at >= $2 AND created_at < $3",
        "abcdef42", lo, hi) == 1
    assert (await _digest(conn, "mqtt_messages", JAN))[0] == ROWS_PER_MONTH + 1
    assert not conn.is_in_transaction()


def test_refused_when_node_id_backfill_pending():
    """A row with from_node_id NULL and a JSON payload (what the startup
    backfill still has to fix) refuses the move; non-JSON payloads with NULL
    node ids never block it."""
    _run(_backfill_pending_scenario)


async def _backfill_pending_scenario(conn: asyncpg.Connection) -> None:
    default_ts = await default_tablespace(conn)
    part = await _partition(conn, MQTT_JAN)
    row_id = _row_id(JAN, 0)
    # The trigger fires BEFORE INSERT only, so an UPDATE leaves the row pending.
    await conn.execute(f"UPDATE {MQTT_JAN} SET from_node_id = NULL WHERE id = $1", row_id)
    assert await conn.fetchval(f"SELECT from_node_id FROM {MQTT_JAN} WHERE id = $1", row_id) is None

    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, part, TABLESPACE, policy=POLICY)
    assert "backfill" in str(excinfo.value)
    assert not isinstance(excinfo.value, TieringBusy)
    assert not conn.is_in_transaction()
    cycle = await run_cycle(conn, POLICY, only=[MQTT_JAN])
    assert [r.status for r in cycle.results] == ["refused"]
    assert "backfill" in cycle.results[0].reason and cycle.refused == 1

    same = await _partition(conn, MQTT_JAN)
    assert same.oid == part.oid and same.on_tablespace(default_ts)
    assert await _scratch_objects(conn) == []

    # Once the pending row is fixed only the legacy non-JSON rows keep NULL ids, and the move proceeds.
    await conn.execute(f"UPDATE {MQTT_JAN} SET from_node_id = $2 WHERE id = $1", row_id, "abcdef00")
    assert await conn.fetchval(
        f"SELECT count(*) FROM {MQTT_JAN} WHERE from_node_id IS NULL") == ROWS_PER_MONTH // NON_JSON_EVERY
    res = await move_partition(conn, await _partition(conn, MQTT_JAN), TABLESPACE, policy=POLICY)
    assert res.status == "moved" and res.rows == ROWS_PER_MONTH


def test_refused_for_live_month_not_closed_or_not_cold():
    """The live partition for the current month (2026_11 when this was written)
    is never moved: refused as not closed at the real clock and as not cold at
    a clock one month later; the DEFAULT partition is refused outright; a
    synthetic closed-but-not-cold month is refused for the cold tablespace."""
    _run(_not_cold_scenario)


async def _not_cold_scenario(conn: asyncpg.Connection) -> None:
    now = await db_now(conn)
    current = now.astimezone(UTC).date().replace(day=1)
    live_parts = await list_partitions(conn, "mqtt_messages")
    live = [p for p in live_parts if p.is_monthly() and p.month >= current]
    assert live, "expected the app-managed partition for the current month"
    part = live[0]
    state0 = (part.oid, part.tablespace, sorted(part.tablespaces()), await _bound(conn, part.name))

    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, part, TABLESPACE, policy=POLICY, dry_run=True)
    assert "not closed" in str(excinfo.value)

    nxt = add_months(part.month, 1)
    later = datetime.datetime(nxt.year, nxt.month, 15, tzinfo=UTC)
    assert not is_cold(part.month, later, POLICY.cold_after_months)
    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, part, TABLESPACE, policy=POLICY, now=later, dry_run=True)
    assert "not cold" in str(excinfo.value)

    cycle = await run_cycle(conn, POLICY, only=[part.name])
    assert [r.status for r in cycle.results] == ["refused"] and cycle.refused == 1
    assert await plan(conn, POLICY, only=[part.name]) == []
    assert await plan(conn, POLICY, only=[part.name], now=later) == []

    default_part = next(p for p in live_parts if p.bound.strip().upper() == "DEFAULT")
    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, default_part, TABLESPACE, policy=POLICY, dry_run=True)
    assert "DEFAULT" in str(excinfo.value)

    # 2025_01 at a clock where it is closed but not yet cold (cutoff 2024-12 for 3 months).
    march = datetime.datetime(2025, 3, 15, tzinfo=UTC)
    assert cold_cutoff(march, POLICY.cold_after_months) == datetime.date(2024, 12, 1)
    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, await _partition(conn, MQTT_JAN), TABLESPACE, policy=POLICY, now=march)
    assert "not cold" in str(excinfo.value)

    same = await _partition(conn, part.name)
    assert (same.oid, same.tablespace, sorted(same.tablespaces()), await _bound(conn, part.name)) == state0
    assert await _scratch_objects(conn) == []
    assert not conn.is_in_transaction()


def test_refused_for_missing_tablespace():
    """A target tablespace that does not exist is refused before anything is
    touched, directly and through run_cycle; an invalid policy never runs."""
    _run(_missing_tablespace_scenario)


async def _missing_tablespace_scenario(conn: asyncpg.Connection) -> None:
    default_ts = await default_tablespace(conn)
    part = await _partition(conn, MQTT_JAN)
    missing = "meshinfo_tiering_no_such_tablespace"
    assert not await tablespace_exists(conn, missing)

    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, part, missing, policy=POLICY)
    assert "does not exist" in str(excinfo.value) and missing in str(excinfo.value)

    cycle = await run_cycle(conn, POLICY, only=[MQTT_JAN, RECV_JAN], target=missing, max_partitions=0)
    assert [r.status for r in cycle.results] == ["refused", "refused"]
    assert cycle.refused == 2 and all(missing in r.reason for r in cycle.results)
    assert cycle.target == missing

    with pytest.raises(TieringRefused) as excinfo:
        await run_cycle(conn, dataclasses.replace(POLICY, cold_tablespace="not an identifier"), only=[MQTT_JAN])
    assert "cold_tablespace" in str(excinfo.value)

    for name in (MQTT_JAN, RECV_JAN):
        same = await _partition(conn, name)
        assert same.on_tablespace(default_ts)
    assert (await _partition(conn, MQTT_JAN)).oid == part.oid
    assert await _scratch_objects(conn) == []
    assert not conn.is_in_transaction()


def test_refused_when_cold_filesystem_unreadable_or_full(tmp_path):
    """policy.cold_filesystem pointing at a missing path refuses the move; so
    does a readable path without the reserve; the check guards only the cold
    tablespace and passes with a sane reserve."""
    _run(_free_space_scenario, tmp_path)


async def _free_space_scenario(conn: asyncpg.Connection, tmp_path) -> None:
    default_ts = await default_tablespace(conn)
    part = await _partition(conn, MQTT_JAN)
    missing_dir = str(tmp_path / "no-such-cold-mount")
    unreadable = dataclasses.replace(POLICY, cold_filesystem=missing_dir)

    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, part, TABLESPACE, policy=unreadable)
    assert "cannot stat cold_filesystem" in str(excinfo.value) and missing_dir in str(excinfo.value)

    full = dataclasses.replace(POLICY, cold_filesystem=str(tmp_path), min_free_mb=2 ** 40)
    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, part, TABLESPACE, policy=full)
    assert "free space" in str(excinfo.value)

    same = await _partition(conn, MQTT_JAN)
    assert same.oid == part.oid and same.on_tablespace(default_ts)
    assert await _scratch_objects(conn) == []
    assert not conn.is_in_transaction()

    # Only the cold tablespace is guarded: the default tablespace never consults the path
    # (the partition already lives there, so this is a plain "skipped").
    res = await move_partition(conn, same, default_ts, policy=unreadable)
    assert res.status == "skipped"

    sane = dataclasses.replace(POLICY, cold_filesystem=str(tmp_path), min_free_mb=0)
    res = await move_partition(conn, await _partition(conn, MQTT_JAN), TABLESPACE, policy=sane)
    assert res.status == "moved" and res.rows == ROWS_PER_MONTH
    assert (await _partition(conn, MQTT_JAN)).on_tablespace(TABLESPACE)

    # The guard protects the cold dataset: moving BACK to the default tablespace
    # must work even while the cold path is unreadable (the documented escape hatch).
    res = await move_partition(conn, await _partition(conn, MQTT_JAN), default_ts, policy=unreadable)
    assert res.status == "moved" and res.target == default_ts
    assert (await _partition(conn, MQTT_JAN)).on_tablespace(default_ts)


def test_dry_run_changes_nothing():
    """dry_run reports rows/indexes/bytes and "would move", then rolls back:
    same oid, tablespace, indexes and data; no scratch objects."""
    _run(_dry_run_scenario)


async def _dry_run_scenario(conn: asyncpg.Connection) -> None:
    default_ts = await default_tablespace(conn)
    before = {name: (await _partition(conn, name), await _index_layout(conn, name)) for name in (MQTT_JAN, RECV_JAN)}
    snapshots = {t: await _digest(conn, t, JAN) for t in TIERABLE_TABLES}

    cycle = await run_cycle(conn, POLICY, only=[MQTT_JAN, RECV_JAN], dry_run=True, deep_verify=True,
                            max_partitions=0)

    assert cycle.dry_run is True
    assert [r.status for r in cycle.results] == ["dry-run", "dry-run"]
    assert cycle.planned == 2 and cycle.moved == 0 and cycle.failed == 0
    assert "would move" in cycle.summary()
    for res in cycle.results:
        part0, layout0 = before[res.partition]
        assert res.rows == snapshots[res.table][0]
        assert res.indexes == len(layout0)
        assert res.reason == f"would move to {TABLESPACE}"
        assert res.bytes_before > 0
        assert res.kept_original is None
        part1 = await _partition(conn, res.partition)
        assert part1.oid == part0.oid
        assert part1.on_tablespace(default_ts) and not part1.partial()
        assert await _index_layout(conn, res.partition) == layout0
    assert {t: await _digest(conn, t, JAN) for t in TIERABLE_TABLES} == snapshots
    assert await _scratch_objects(conn) == []
    assert not conn.is_in_transaction()

    direct = await move_partition(conn, before[MQTT_JAN][0], TABLESPACE, policy=POLICY, dry_run=True)
    assert direct.status == "dry-run" and direct.rows == ROWS_PER_MONTH
    assert (await _partition(conn, MQTT_JAN)).oid == before[MQTT_JAN][0].oid
    assert await _scratch_objects(conn) == []


def test_concurrent_access_exclusive_lock_is_busy():
    """With another session holding ACCESS EXCLUSIVE on the partition the move
    gives up after lock_timeout (5 s) with TieringBusy — never queueing behind
    the lock — and leaves nothing behind; it succeeds once the lock is gone."""
    _run(_busy_scenario)


async def _busy_scenario(conn: asyncpg.Connection) -> None:
    default_ts = await default_tablespace(conn)
    part = await _partition(conn, MQTT_JAN)
    holder = await asyncpg.connect(DSN, command_timeout=None)
    try:
        hold = holder.transaction()
        await hold.start()
        await holder.execute(f"LOCK TABLE {MQTT_JAN} IN ACCESS EXCLUSIVE MODE")

        started = time.monotonic()
        with pytest.raises(TieringBusy) as excinfo:
            await asyncio.wait_for(move_partition(conn, part, TABLESPACE, policy=POLICY), timeout=30)
        elapsed = time.monotonic() - started
        assert elapsed < 8.0, f"TieringBusy took {elapsed:.1f}s (lock_timeout {COPY_LOCK_TIMEOUT})"
        assert isinstance(excinfo.value, TieringRefused)
        assert "lock" in str(excinfo.value).lower()
        assert not conn.is_in_transaction()

        # The scheduler path (run_cycle) must not queue behind the lock either: it
        # surfaces as a "busy" result, or as TieringBusy when listing the partition
        # (pg_total_relation_size takes ACCESS SHARE) already hits lock_timeout.
        started = time.monotonic()
        try:
            cycle = await asyncio.wait_for(run_cycle(conn, POLICY, only=[MQTT_JAN]), timeout=30)
        except TieringBusy:
            pass
        else:
            assert [r.status for r in cycle.results] == ["busy"] and cycle.busy == 1
        assert time.monotonic() - started < 8.0
        assert not conn.is_in_transaction()

        await hold.rollback()
    finally:
        await holder.close()

    same = await _partition(conn, MQTT_JAN)
    assert same.oid == part.oid and same.on_tablespace(default_ts)
    assert await _scratch_objects(conn) == []
    res = await move_partition(conn, same, TABLESPACE, policy=POLICY)
    assert res.status == "moved" and res.swap_attempts == 1
    assert (await _partition(conn, MQTT_JAN)).on_tablespace(TABLESPACE)


def test_move_back_to_default_tablespace():
    """The --tablespace pg_default direction: run_cycle(target=<default>) moves
    2025_01 back from the cold tablespace, which any closed month may do even
    when it is not cold (the cold tablespace stays off-limits to such months)."""
    _run(_move_back_scenario)


async def _move_back_scenario(conn: asyncpg.Connection) -> None:
    default_ts = await default_tablespace(conn)
    assert default_ts != TABLESPACE
    layouts = {name: await _index_layout(conn, name) for name in (MQTT_JAN, RECV_JAN)}
    snapshots = {t: await _digest(conn, t, JAN) for t in TIERABLE_TABLES}
    bounds = {name: await _bound(conn, name) for name in (MQTT_JAN, RECV_JAN)}

    cold = await run_cycle(conn, POLICY, only=[MQTT_JAN, RECV_JAN], max_partitions=0)
    assert [r.status for r in cold.results] == ["moved", "moved"]
    for name in (MQTT_JAN, RECV_JAN):
        assert (await _partition(conn, name)).on_tablespace(TABLESPACE)

    # Planned for the default tablespace: as cold months at the real clock ...
    items = await plan(conn, POLICY, target=default_ts, only=[MQTT_JAN, RECV_JAN])
    assert [(i.partition.name, i.target) for i in items] == [(MQTT_JAN, default_ts), (RECV_JAN, default_ts)]
    assert all(i.reason.startswith("cold") and TABLESPACE in i.reason for i in items)
    # ... and as merely closed months at a clock where they are not cold yet.
    march = datetime.datetime(2025, 3, 15, tzinfo=UTC)
    assert not is_cold(JAN, march, POLICY.cold_after_months)
    items = await plan(conn, POLICY, target=default_ts, now=march, only=[MQTT_JAN, RECV_JAN])
    assert [i.partition.name for i in items] == [MQTT_JAN, RECV_JAN]
    assert all(i.reason.startswith("closed") for i in items)

    back = await run_cycle(conn, POLICY, only=[MQTT_JAN, RECV_JAN], target=default_ts, now=march,
                           max_partitions=0)

    assert [r.status for r in back.results] == ["moved", "moved"] and back.target == default_ts
    for res in back.results:
        assert res.target == default_ts and res.rows == snapshots[res.table][0]
        await _assert_layout(conn, res.partition, default_ts, indexes_before=layouts[res.partition])
        assert await _bound(conn, res.partition) == bounds[res.partition]
        # Back on the database default: stored as reltablespace 0, like a fresh partition.
        assert await conn.fetchval(
            "SELECT reltablespace::bigint FROM pg_class WHERE oid = to_regclass($1)", res.partition) == 0
    assert {t: await _digest(conn, t, JAN) for t in TIERABLE_TABLES} == snapshots
    assert await _scratch_objects(conn) == []

    # The cold tablespace still requires a cold month.
    with pytest.raises(TieringRefused) as excinfo:
        await move_partition(conn, await _partition(conn, MQTT_JAN), TABLESPACE, policy=POLICY, now=march)
    assert "not cold" in str(excinfo.value)
    assert (await _partition(conn, MQTT_JAN)).on_tablespace(default_ts)
    assert not conn.is_in_transaction()


def test_plan_lists_cold_months_oldest_first():
    """plan() proposes the synthetic months oldest first (mqtt before
    receptions) for the cold tablespace, never an unclosed month, honours
    `limit` and `only`, and has nothing to do for the default tablespace."""
    _run(_plan_scenario)


async def _plan_scenario(conn: asyncpg.Connection) -> None:
    default_ts = await default_tablespace(conn)
    now = await db_now(conn)
    current = now.astimezone(UTC).date().replace(day=1)
    cutoff = cold_cutoff(now, POLICY.cold_after_months)
    assert FEB < cutoff

    items = await plan(conn, POLICY)
    assert [i.partition.name for i in items if i.partition.name in SYNTHETIC] == list(SYNTHETIC)
    assert all(i.partition.is_monthly() and i.partition.month < cutoff for i in items)
    assert all(i.partition.month < current for i in items)
    assert all(i.target == TABLESPACE for i in items)
    synthetic_items = [i for i in items if i.partition.name in SYNTHETIC]
    assert all(i.reason.startswith("cold") and default_ts in i.reason for i in synthetic_items)

    assert [i.partition.name for i in await plan(conn, POLICY, limit=1)] == [items[0].partition.name]
    assert [i.partition.name for i in await plan(conn, POLICY, only=[RECV_FEB])] == [RECV_FEB]
    assert [i.partition.name for i in await plan(conn, POLICY, only=[MQTT_FEB, MQTT_JAN])] == [MQTT_JAN, MQTT_FEB]
    assert await plan(conn, POLICY, target=default_ts, only=list(SYNTHETIC)) == []
    receptions_only = await plan(conn, dataclasses.replace(POLICY, tables=("packet_receptions",)),
                                 only=list(SYNTHETIC))
    assert [i.partition.name for i in receptions_only] == [RECV_JAN, RECV_FEB]
    assert await _scratch_objects(conn) == []


def test_swap_retries_after_lock_timeout_then_succeeds():
    """A reader holding ACCESS SHARE on the parent blocks the swap's ACCESS
    EXCLUSIVE: with the lock timeout shortened to 1 s the first attempt rolls
    back to the savepoint and a later attempt succeeds once the reader is gone
    (swap_attempts > 1, layout intact)."""
    _run(_swap_retry_scenario)


async def _swap_retry_scenario(conn: asyncpg.Connection) -> None:
    import storage.db.tiering as tiering_mod
    saved = (tiering_mod.SWAP_LOCK_TIMEOUT, tiering_mod.SWAP_ATTEMPTS, tiering_mod.LONG_HOLDER_SECONDS)
    tiering_mod.SWAP_LOCK_TIMEOUT, tiering_mod.SWAP_ATTEMPTS, tiering_mod.LONG_HOLDER_SECONDS = "1s", 4, 1e9
    holder = await asyncpg.connect(DSN, command_timeout=None)
    try:
        hold = holder.transaction()
        await hold.start()
        await holder.execute("LOCK TABLE mqtt_messages IN ACCESS SHARE MODE")

        async def release_later() -> None:
            await asyncio.sleep(2.5)
            await hold.rollback()

        releaser = asyncio.create_task(release_later())
        part = await _partition(conn, MQTT_JAN)
        layout = await _index_layout(conn, MQTT_JAN)
        snapshot = await _digest(conn, "mqtt_messages", JAN)
        res = await asyncio.wait_for(move_partition(conn, part, TABLESPACE, policy=POLICY), timeout=60)
        await releaser
        assert res.status == "moved" and res.swap_attempts >= 2, res
        await _assert_layout(conn, MQTT_JAN, TABLESPACE, indexes_before=layout)
        assert await _digest(conn, "mqtt_messages", JAN) == snapshot
        assert not conn.is_in_transaction()
    finally:
        tiering_mod.SWAP_LOCK_TIMEOUT, tiering_mod.SWAP_ATTEMPTS, tiering_mod.LONG_HOLDER_SECONDS = saved
        await holder.close()


def test_swap_postponed_behind_a_long_holder_is_busy():
    """A session that has held a lock on the parent for longer than the probe
    window makes every attempt pointless: the swap is postponed without ever
    queueing an ACCESS EXCLUSIVE request, and after the last attempt the move
    is busy with the original untouched and the copy discarded."""
    _run(_long_holder_scenario)


async def _long_holder_scenario(conn: asyncpg.Connection) -> None:
    import storage.db.tiering as tiering_mod
    default_ts = await default_tablespace(conn)
    saved = (tiering_mod.SWAP_LOCK_TIMEOUT, tiering_mod.SWAP_ATTEMPTS, tiering_mod.LONG_HOLDER_SECONDS)
    tiering_mod.SWAP_LOCK_TIMEOUT, tiering_mod.SWAP_ATTEMPTS, tiering_mod.LONG_HOLDER_SECONDS = "1s", 2, 0.5
    holder = await asyncpg.connect(DSN, command_timeout=None)
    try:
        hold = holder.transaction()
        await hold.start()
        await holder.execute("LOCK TABLE mqtt_messages IN ACCESS SHARE MODE")
        await asyncio.sleep(1.0)  # older than LONG_HOLDER_SECONDS
        part = await _partition(conn, MQTT_JAN)
        started = time.monotonic()
        with pytest.raises(TieringBusy) as excinfo:
            await asyncio.wait_for(move_partition(conn, part, TABLESPACE, policy=POLICY), timeout=60)
        assert time.monotonic() - started < 20
        assert "busy" in str(excinfo.value).lower() or "held a lock" in str(excinfo.value)
        assert not conn.is_in_transaction()
        await hold.rollback()
    finally:
        tiering_mod.SWAP_LOCK_TIMEOUT, tiering_mod.SWAP_ATTEMPTS, tiering_mod.LONG_HOLDER_SECONDS = saved
        await holder.close()
    same = await _partition(conn, MQTT_JAN)
    assert same.oid == part.oid and same.on_tablespace(default_ts)
    assert await _scratch_objects(conn) == []
    res = await move_partition(conn, same, TABLESPACE, policy=POLICY)
    assert res.status == "moved" and res.swap_attempts == 1


def test_swap_attempt_never_stalls_other_sessions_longer_than_the_lock_timeout():
    """While a long query holds ACCESS SHARE on the parent, the swap's pending
    ACCESS EXCLUSIVE makes every new query on the parent queue behind it — for
    at most SWAP_LOCK_TIMEOUT, after which the attempt rolls back and the
    queue drains. A probe query issued while the swap is waiting must return
    within that timeout plus a margin, and the move still completes on a
    later attempt once the long query is gone."""
    _run(_stall_bound_scenario)


async def _stall_bound_scenario(conn: asyncpg.Connection) -> None:
    import storage.db.tiering as tiering_mod
    timeout_s = timeout_seconds(tiering_mod.SWAP_LOCK_TIMEOUT)
    assert timeout_s <= 3.0, tiering_mod.SWAP_LOCK_TIMEOUT
    saved = (tiering_mod.SWAP_ATTEMPTS, tiering_mod.LONG_HOLDER_SECONDS)
    # Force a real attempt behind the holder (the long-holder probe would otherwise skip it).
    tiering_mod.SWAP_ATTEMPTS, tiering_mod.LONG_HOLDER_SECONDS = 4, 1e9
    holder = await asyncpg.connect(DSN, command_timeout=None)
    prober = await asyncpg.connect(DSN, command_timeout=None)
    try:
        mover_pid = await conn.fetchval("SELECT pg_backend_pid()")
        parent_oid = await prober.fetchval("SELECT 'mqtt_messages'::regclass::oid")
        hold = holder.transaction()
        await hold.start()
        await holder.execute("LOCK TABLE mqtt_messages IN ACCESS SHARE MODE")  # the long query
        part = await _partition(conn, MQTT_JAN)
        mover = asyncio.create_task(move_partition(conn, part, TABLESPACE, policy=POLICY))
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:  # until the swap's ACCESS EXCLUSIVE request is queued
                queued = await prober.fetchval(
                    "SELECT 1 FROM pg_locks WHERE pid = $1 AND relation = $2 "
                    "AND mode = 'AccessExclusiveLock' AND NOT granted", mover_pid, parent_oid)
                if queued:
                    break
                await asyncio.sleep(0.05)
            assert queued, "the swap never asked for the parent lock"
            started = time.monotonic()
            await prober.fetchval("SELECT count(*) FROM mqtt_messages WHERE false")  # queues behind the swap
            waited = time.monotonic() - started
            assert waited <= timeout_s + 1.5, f"a query waited {waited:.1f}s behind the swap"
        finally:
            await hold.rollback()  # the long query ends; the next attempt goes through
        res = await asyncio.wait_for(mover, timeout=90)
        assert res.status == "moved" and res.swap_attempts >= 2, res
        assert (await _partition(conn, MQTT_JAN)).on_tablespace(TABLESPACE)
        assert not conn.is_in_transaction()
    finally:
        tiering_mod.SWAP_ATTEMPTS, tiering_mod.LONG_HOLDER_SECONDS = saved
        await holder.close()
        await prober.close()


def test_cold_tablespace_creation_against_the_server():
    """ensure_cold_tablespace leaves an existing tablespace alone, refuses with
    an actionable message when the location is not a directory on the server
    (nothing created), and refuses without a location."""
    _run(_ensure_tablespace_scenario)


async def _ensure_tablespace_scenario(conn: asyncpg.Connection) -> None:
    assert await ensure_cold_tablespace(conn, POLICY) is False
    missing = "meshinfo_tiering_no_such_tablespace"
    policy = dataclasses.replace(POLICY, cold_tablespace=missing,
                                 cold_tablespace_location="/nonexistent/meshinfo-tiering-test")
    with pytest.raises(TieringRefused) as excinfo:
        await ensure_cold_tablespace(conn, policy)
    assert "does not exist inside the postgres container" in str(excinfo.value)
    assert "mounted" in str(excinfo.value) and missing in str(excinfo.value)
    assert not await tablespace_exists(conn, missing)
    with pytest.raises(TieringRefused) as excinfo:
        await ensure_cold_tablespace(conn, dataclasses.replace(policy, cold_tablespace_location=""))
    assert "cold_tablespace_location" in str(excinfo.value)
    assert not await tablespace_exists(conn, missing)
    assert not conn.is_in_transaction()
