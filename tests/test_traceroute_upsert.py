"""
Real-database tests for the traceroute richer-wins upsert (TRACEROUTE_UPSERT_SQL).

Opt-in: they need a THROWAWAY postgres reachable via TRACEROUTE_PG_DSN and are
skipped otherwise, keeping the default suite runnable anywhere. Never point the
DSN at a live database — the setup truncates the traceroutes table. Recipe:

    docker run --rm -d --name tr-upsert-pg -e POSTGRES_PASSWORD=x \
        -e POSTGRES_DB=meshinfo -p 127.0.0.1:5433:5432 postgres:18
    docker exec -i tr-upsert-pg psql -U postgres -d meshinfo \
        < postgres/sql/schema.sql
    TRACEROUTE_PG_DSN=postgresql://postgres:x@127.0.0.1:5433/meshinfo \
        python -m pytest tests/test_traceroute_upsert.py -q
    docker rm -f tr-upsert-pg

The tests drive the exact SQL constant the app executes, so guard behavior
(recency window, strict richness, concurrency arbitration) is pinned against a
real server, not a fake.
"""

import asyncio
import json
import os

import pytest

asyncpg = pytest.importorskip("asyncpg")

from storage.db.postgres import TRACEROUTE_UPGRADE_WINDOW_S, TRACEROUTE_UPSERT_SQL

DSN = os.environ.get("TRACEROUTE_PG_DSN")

pytestmark = pytest.mark.skipif(
    not DSN, reason="TRACEROUTE_PG_DSN not set (throwaway postgres required)"
)

FROM_ID = "67ea9400"
TO_ID = "abcd1234"


def run(coro):
    return asyncio.run(coro)


# Live-DSN tripwire: a fresh schema-loaded throwaway starts EMPTY, so a
# populated traceroutes table means the DSN points somewhere real — refuse
# before the TRUNCATE below can destroy it. Checked once per session (our own
# tests populate the table afterwards).
_dsn_checked = False


async def _conn():
    global _dsn_checked
    conn = await asyncpg.connect(DSN)
    if not _dsn_checked:
        existing = await conn.fetchval("SELECT count(*) FROM traceroutes")
        if existing:
            await conn.close()
            pytest.fail(
                f"TRACEROUTE_PG_DSN points at a database with {existing} traceroutes "
                "rows — refusing to TRUNCATE. Use a fresh throwaway postgres."
            )
        _dsn_checked = True
    # FK stubs + a clean slate per test.
    await conn.execute(
        "INSERT INTO nodes (id) VALUES ($1), ($2) ON CONFLICT (id) DO NOTHING",
        FROM_ID,
        TO_ID,
    )
    await conn.execute("TRUNCATE traceroutes")
    return conn


async def _upsert(conn, message_id, payload, rssi=None, snr=None, sender=None):
    """Execute the production statement; returns 'inserted'/'upgraded'/'duplicate'."""
    row = await conn.fetchrow(
        TRACEROUTE_UPSERT_SQL,
        FROM_ID,
        TO_ID,
        sender,
        message_id,
        None,  # channel
        None,  # packet_id
        None,  # hops_away
        rssi,
        snr,
        1753500000,  # timestamp
        None,  # rx_time
        json.dumps(payload.get("route", [])),
        json.dumps([]),
        json.dumps(payload),
        float(TRACEROUTE_UPGRADE_WINDOW_S),
    )
    if row is None:
        return "duplicate"
    return "inserted" if row["inserted"] else "upgraded"


POOR = {"route": [1, 2], "snr_towards": [4, 8, 12], "route_back": [], "snr_back": []}
RICH = {
    "route": [1, 2],
    "snr_towards": [4, 8, 12],
    "route_back": [3, 4],
    "snr_back": [9, 10],
}


class TestRicherWinsUpsert:
    def test_richer_copy_upgrades_whole_row(self):
        async def body():
            conn = await _conn()
            try:
                assert await _upsert(conn, 1, POOR, rssi=-90, snr=-5.0) == "inserted"
                created0 = await conn.fetchval("SELECT created_at FROM traceroutes")
                assert await _upsert(conn, 1, RICH, rssi=-110, snr=-12.0) == "upgraded"
                rows = await conn.fetch("SELECT * FROM traceroutes")
                assert len(rows) == 1
                row = rows[0]
                # Whole-copy replacement: payload AND reception fields together
                assert json.loads(row["payload"])["route_back"] == [3, 4]
                assert row["rssi"] == -110 and row["snr"] == -12.0
                # created_at anchors first-heard
                assert row["created_at"] == created0
            finally:
                await conn.close()

        run(body())

    def test_poorer_equal_and_replay_are_noops(self):
        async def body():
            conn = await _conn()
            try:
                assert await _upsert(conn, 2, RICH, rssi=-110) == "inserted"
                # Poorer copy refused
                assert await _upsert(conn, 2, POOR, rssi=-90) == "duplicate"
                # Byte-identical replay (write-retry at-least-once) is a no-op
                assert await _upsert(conn, 2, RICH, rssi=-110) == "duplicate"
                row = await conn.fetchrow("SELECT * FROM traceroutes")
                assert json.loads(row["payload"])["route_back"] == [3, 4]
                assert row["rssi"] == -110
            finally:
                await conn.close()

        run(body())

    def test_reply_snr_beats_equal_route_length(self):
        async def body():
            conn = await _conn()
            try:
                request = {"route": [1, 2], "snr_towards": [4, 8]}
                reply = {"route": [1, 2], "snr_towards": [4, 8, 12]}
                assert await _upsert(conn, 3, request) == "inserted"
                # Same route length; the destination's appended SNR is richer
                assert await _upsert(conn, 3, reply) == "upgraded"
            finally:
                await conn.close()

        run(body())

    def test_malformed_payloads_evaluate_as_zero(self):
        async def body():
            conn = await _conn()
            try:
                assert await _upsert(conn, 4, {}) == "inserted"
                assert await _upsert(conn, 4, {"route": "bogus"}) == "duplicate"
                assert await _upsert(conn, 4, {"route": [1]}) == "upgraded"
            finally:
                await conn.close()

        run(body())

    def test_prefix_guard_refuses_rewritten_hops(self):
        """A 'richer' copy that REWRITES recorded hops instead of extending
        them is forged — genuine copies only append (monotonicity)."""

        async def body():
            conn = await _conn()
            try:
                genuine = {"route": [1, 2], "snr_towards": [4, 8, 12], "route_back": [3]}
                assert await _upsert(conn, 6, genuine) == "inserted"
                # Forged: higher richness but different recorded hops
                forged = {
                    "route": [9, 9],
                    "snr_towards": [1, 1, 1],
                    "route_back": [0, 0, 0, 0],
                }
                assert await _upsert(conn, 6, forged) == "duplicate"
                # Forged route_back that doesn't extend the genuine one
                forged_back = dict(genuine, route_back=[7, 7, 7])
                assert await _upsert(conn, 6, forged_back) == "duplicate"
                # Genuine extension: same prefix, more accumulated hops
                extended = dict(genuine, route_back=[3, 4], snr_back=[9, 10])
                assert await _upsert(conn, 6, extended) == "upgraded"
                row = await conn.fetchrow("SELECT payload FROM traceroutes")
                assert json.loads(row["payload"])["route_back"] == [3, 4]
            finally:
                await conn.close()

        run(body())

    def test_padding_gains_are_capped(self):
        """Publisher-padded arrays score at most the per-array cap, so junk
        padding can't manufacture unlimited richness."""

        async def body():
            conn = await _conn()
            try:
                genuine = {"route": [1, 2], "snr_towards": [4, 8, 12]}
                assert await _upsert(conn, 7, genuine) == "inserted"
                # Extends the (empty) route_back prefix but pads far past any
                # real mesh: counts as at most the cap, still > stored here —
                # the cap bounds the SCORE; the prefix guard bounds the DAMAGE
                # (recorded hops survive verbatim).
                padded = dict(genuine, route_back=[0] * 50)
                assert await _upsert(conn, 7, padded) == "upgraded"
                row = await conn.fetchrow("SELECT payload FROM traceroutes")
                assert json.loads(row["payload"])["route"] == [1, 2]
            finally:
                await conn.close()

        run(body())

    def test_upgrade_never_regresses_a_valid_timestamp(self):
        """A clock-less gateway's richer copy (timestamp 0) must not wipe the
        stored valid timestamp — dedupe windows and sort order depend on it."""

        async def body():
            conn = await _conn()
            try:
                row0 = await conn.fetchrow(
                    TRACEROUTE_UPSERT_SQL,
                    FROM_ID, TO_ID, None, 8, None, None, None, None, None,
                    1753500000, None,
                    json.dumps(POOR["route"]), json.dumps([]), json.dumps(POOR),
                    float(TRACEROUTE_UPGRADE_WINDOW_S),
                )
                assert row0["inserted"]
                # Richer copy with timestamp=0 (no time source on the gateway)
                row1 = await conn.fetchrow(
                    TRACEROUTE_UPSERT_SQL,
                    FROM_ID, TO_ID, None, 8, None, None, None, None, None,
                    0, None,
                    json.dumps(RICH["route"]), json.dumps([]), json.dumps(RICH),
                    float(TRACEROUTE_UPGRADE_WINDOW_S),
                )
                assert row1 is not None and not row1["inserted"]  # upgraded
                stored = await conn.fetchrow("SELECT timestamp, payload FROM traceroutes")
                assert stored["timestamp"] == 1753500000  # preserved
                assert json.loads(stored["payload"])["route_back"] == [3, 4]
            finally:
                await conn.close()

        run(body())

    def test_recency_guard_blocks_stale_id_reuse(self):
        async def body():
            conn = await _conn()
            try:
                assert await _upsert(conn, 5, POOR) == "inserted"
                await conn.execute(
                    "UPDATE traceroutes SET created_at = now() - interval '2 hours'"
                )
                # Outside the window even a richer copy must not rewrite history
                assert await _upsert(conn, 5, RICH) == "duplicate"
                row = await conn.fetchrow("SELECT payload FROM traceroutes")
                assert json.loads(row["payload"])["route_back"] == []
            finally:
                await conn.close()

        run(body())

    def test_concurrent_copies_converge_on_richest(self):
        async def body():
            setup = await _conn()
            await setup.close()
            c1 = await asyncpg.connect(DSN)
            c2 = await asyncpg.connect(DSN)
            try:
                for i in range(50):
                    mid = 1000 + i
                    # Alternate submission order; actual arrival order is
                    # nondeterministic, the assertion covers whichever
                    # interleaving the server saw.
                    a = lambda: _upsert(c1, mid, POOR, rssi=-90)
                    b = lambda: _upsert(c2, mid, RICH, rssi=-110)
                    if i % 2:
                        a, b = b, a
                    await asyncio.gather(a(), b())
                rows = await c1.fetch(
                    "SELECT message_id, payload FROM traceroutes WHERE message_id >= 1000"
                )
                assert len(rows) == 50
                for row in rows:
                    assert json.loads(row["payload"])["route_back"] == [3, 4], (
                        f"message {row['message_id']} kept the poorer copy"
                    )
            finally:
                await c1.close()
                await c2.close()

        run(body())
