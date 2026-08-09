"""Real-database guard tests (gated on MESHINFO_TEST_DSN): wire-name heal path
and resolver seed query. Synthetic rows only; cleanup is verified in-test."""

import asyncio
import os
import time
from urllib.parse import urlsplit

import pytest

from storage.db.postgres import PostgresStorage

DSN = os.environ.get("MESHINFO_TEST_DSN", "")

pytestmark = pytest.mark.skipif(not DSN, reason="MESHINFO_TEST_DSN not set")

# Live packet ids are uint32 (~4.3e9); these cannot collide with real data.
BASE_MSG_ID = 9_100_000_000_000_000
NODE_ID = "beefbeef"
CANDIDATE_BUCKETS = [str(i) for i in range(240, 250)]


def _make_storage() -> PostgresStorage:
    u = urlsplit(DSN)
    return PostgresStorage(
        {
            "server": {"timezone": "UTC"},
            "storage": {
                "postgres": {
                    "enabled": True,
                    "host": u.hostname,
                    "port": u.port or 5432,
                    "database": u.path.lstrip("/"),
                    "username": u.username,
                    "password": u.password,
                    "raise_on_write_error": True,
                }
            },
        }
    )


async def _pick_free_buckets(conn, n: int) -> list:
    used = {
        r["id"]
        for r in await conn.fetch(
            "SELECT id FROM chat_channels WHERE id = ANY($1)", CANDIDATE_BUCKETS
        )
    }
    free = [b for b in CANDIDATE_BUCKETS if b not in used]
    assert len(free) >= n, f"not enough free synthetic buckets in {CANDIDATE_BUCKETS}"
    return free[:n]


async def _synthetic_counts(conn, msg_ids, bucket_ids, names=()) -> dict:
    return {
        "messages": await conn.fetchval(
            "SELECT count(*) FROM chat_messages WHERE id = ANY($1)", list(msg_ids)
        ),
        "buckets": await conn.fetchval(
            "SELECT count(*) FROM chat_channels WHERE id = ANY($1)", list(bucket_ids)
        ),
        "names": await conn.fetchval(
            "SELECT count(*) FROM chat_channels WHERE name = ANY($1)", list(names)
        ),
        "nodes": await conn.fetchval(
            "SELECT count(*) FROM nodes WHERE id = $1", NODE_ID
        ),
    }


async def _cleanup(conn, msg_ids, bucket_ids):
    await conn.execute("DELETE FROM chat_messages WHERE id = ANY($1)", list(msg_ids))
    await conn.execute("DELETE FROM chat_channels WHERE id = ANY($1)", list(bucket_ids))
    await conn.execute("DELETE FROM nodes WHERE id = $1", NODE_ID)


def _msg(msg_id: int, channel: str, channel_name=None) -> dict:
    m = {"id": msg_id, "channel": channel, "text": "synthetic guard test", "timestamp": int(time.time())}
    if channel_name is not None:
        m["channel_name"] = channel_name
    return m


async def _bucket_name(conn, bucket: str):
    return await conn.fetchval("SELECT name FROM chat_channels WHERE id = $1", bucket)


def test_wire_name_heal_end_to_end():
    """Heal fills placeholders only; index buckets and PKI never heal."""
    asyncio.run(_heal_scenario())


async def _heal_scenario():
    st = _make_storage()
    assert await st.connect()
    try:
        async with st.pool.acquire() as conn:
            heal_bkt, pki_bkt = await _pick_free_buckets(conn, 2)
            msg_ids = [BASE_MSG_ID + i for i in range(6)]
            buckets = [heal_bkt, pki_bkt]

            before = await _synthetic_counts(conn, msg_ids, buckets)
            assert before == {"messages": 0, "buckets": 0, "names": 0, "nodes": 0}

            name0_before = await _bucket_name(conn, "0")
            assert name0_before is not None, "expected chat_channels bucket '0' to exist"

        try:
            # Index bucket: wire name must not touch the stored name.
            await st.write_chat_message(NODE_ID, _msg(msg_ids[0], "0", "MediumFast"))
            # Hash bucket: placeholder, then healed, then no overwrite.
            await st.write_chat_message(NODE_ID, _msg(msg_ids[1], heal_bkt))
            async with st.pool.acquire() as conn:
                assert await _bucket_name(conn, heal_bkt) == f"Channel {heal_bkt}"
            await st.write_chat_message(NODE_ID, _msg(msg_ids[2], heal_bkt, "SynthWireA"))
            async with st.pool.acquire() as conn:
                assert await _bucket_name(conn, heal_bkt) == "SynthWireA"
            await st.write_chat_message(NODE_ID, _msg(msg_ids[3], heal_bkt, "SynthWireB"))
            async with st.pool.acquire() as conn:
                assert await _bucket_name(conn, heal_bkt) == "SynthWireA"
            # PKI never heals.
            await st.write_chat_message(NODE_ID, _msg(msg_ids[4], pki_bkt))
            await st.write_chat_message(NODE_ID, _msg(msg_ids[5], pki_bkt, "PKI"))
            async with st.pool.acquire() as conn:
                assert await _bucket_name(conn, pki_bkt) == f"Channel {pki_bkt}"
                assert await _bucket_name(conn, "0") == name0_before
        finally:
            async with st.pool.acquire() as conn:
                await _cleanup(conn, msg_ids, buckets)
                after = await _synthetic_counts(conn, msg_ids, buckets)
                assert after == {"messages": 0, "buckets": 0, "names": 0, "nodes": 0}
                assert await _bucket_name(conn, "0") == name0_before
    finally:
        await st.close()


def test_channel_name_provenance_stored():
    """Rows store their wire name (incl. PKI); NULL when absent."""
    asyncio.run(_provenance_scenario())


async def _provenance_scenario():
    st = _make_storage()
    assert await st.connect()
    try:
        async with st.pool.acquire() as conn:
            (bkt,) = await _pick_free_buckets(conn, 1)
            msg_ids = [BASE_MSG_ID + 100 + i for i in range(3)]
            before = await _synthetic_counts(conn, msg_ids, [bkt])
            assert before["messages"] == 0 and before["buckets"] == 0

        try:
            await st.write_chat_message(NODE_ID, _msg(msg_ids[0], bkt, "SynthProv"))
            await st.write_chat_message(NODE_ID, _msg(msg_ids[1], bkt))
            await st.write_chat_message(NODE_ID, _msg(msg_ids[2], "0", "PKI"))
            async with st.pool.acquire() as conn:
                got = {
                    r["id"]: r["channel_name"]
                    for r in await conn.fetch(
                        "SELECT id, channel_name FROM chat_messages WHERE id = ANY($1)",
                        msg_ids,
                    )
                }
            assert got[msg_ids[0]] == "SynthProv"
            assert got[msg_ids[1]] is None
            assert got[msg_ids[2]] == "PKI"
        finally:
            async with st.pool.acquire() as conn:
                await _cleanup(conn, msg_ids, [bkt])
                after = await _synthetic_counts(conn, msg_ids, [bkt])
                assert after["messages"] == 0 and after["buckets"] == 0
    finally:
        await st.close()


def test_seed_learns_from_row_names():
    """get_wire_channel_names also learns from per-row channel_name provenance."""
    asyncio.run(_row_seed_scenario())


async def _row_seed_scenario():
    st = _make_storage()
    assert await st.connect()
    try:
        async with st.pool.acquire() as conn:
            (bkt,) = await _pick_free_buckets(conn, 1)
            msg_id = BASE_MSG_ID + 200

        try:
            # Bucket name stays a placeholder; only the ROW carries the name.
            await st.write_chat_message(NODE_ID, _msg(msg_id, bkt, "SynthRowSeed"))
            async with st.pool.acquire() as conn:
                await conn.execute(
                    "UPDATE chat_channels SET name = $2 WHERE id = $1",
                    bkt, f"Channel {bkt}",
                )
            seeds = await st.get_wire_channel_names()
            assert seeds.get("SynthRowSeed") == int(bkt)
        finally:
            async with st.pool.acquire() as conn:
                await _cleanup(conn, [msg_id], [bkt])
    finally:
        await st.close()


def test_packet_lookup_by_sender_and_packet_id():
    """(sender, mesh packet id) resolves to the newest archive row and agrees
    with the row-id lookup."""
    asyncio.run(_packet_lookup_scenario())


async def _packet_lookup_scenario():
    st = _make_storage()
    assert await st.connect()
    row_ids = [BASE_MSG_ID + 300, BASE_MSG_ID + 301]
    mesh_packet_id = 4_060_000_123
    try:
        async with st.pool.acquire() as conn:
            assert await conn.fetchval(
                "SELECT count(*) FROM mqtt_messages WHERE id = ANY($1)", row_ids
            ) == 0

        try:
            async with st.pool.acquire() as conn:
                # Same (sender, packet id) twice — id reuse; newest row must win.
                for age_s, rid in zip((1, 0), row_ids):
                    await conn.execute(
                        """INSERT INTO mqtt_messages
                               (id, topic, payload, from_node_id, packet_id, created_at)
                           VALUES ($1, $2, $3, $4, $5, now() - interval '1 second' * $6)""",
                        rid, "msh/US/synthetic/test",
                        f'{{"id": {mesh_packet_id}, "from": {int(NODE_ID, 16)}}}',
                        NODE_ID, mesh_packet_id, age_s,
                    )

            by_packet = await st.query_mqtt_message_by_packet(NODE_ID, mesh_packet_id)
            assert by_packet is not None
            assert by_packet["mqtt_row_id"] == row_ids[-1]
            by_id = await st.query_mqtt_message_by_id(row_ids[-1])
            assert by_id == by_packet
        finally:
            async with st.pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM mqtt_messages WHERE id = ANY($1)", row_ids
                )
                assert await conn.fetchval(
                    "SELECT count(*) FROM mqtt_messages WHERE id = ANY($1)", row_ids
                ) == 0
    finally:
        await st.close()


def test_get_wire_channel_names():
    """Seed returns only >7 buckets with unambiguous non-placeholder names."""
    asyncio.run(_wire_names_scenario())


async def _wire_names_scenario():
    st = _make_storage()
    assert await st.connect()
    try:
        async with st.pool.acquire() as conn:
            free = await _pick_free_buckets(conn, 6)
            uniq, pki, dup1, dup2, ph, gen = free
            rows = [
                (uniq, "SynthUniqueWire"),
                (pki, "PKI"),
                (dup1, "SynthDupWire"),
                (dup2, "SynthDupWire"),
                (ph, f"Channel {ph}"),
                (gen, "General"),
            ]
            names = ["SynthUniqueWire", "SynthDupWire"]

            before = await _synthetic_counts(conn, [], free, names)
            assert before == {"messages": 0, "buckets": 0, "names": 0, "nodes": 0}

        try:
            async with st.pool.acquire() as conn:
                for bid, name in rows:
                    await conn.execute(
                        "INSERT INTO chat_channels (id, name) VALUES ($1, $2)", bid, name
                    )

            result = await st.get_wire_channel_names()

            assert result["SynthUniqueWire"] == int(uniq)
            assert "PKI" not in result
            assert "SynthDupWire" not in result
            assert f"Channel {ph}" not in result
            assert "General" not in result
            for name, h in result.items():
                assert isinstance(h, int)
                assert 8 <= h <= 255
        finally:
            async with st.pool.acquire() as conn:
                await _cleanup(conn, [], free)
                after = await _synthetic_counts(conn, [], free, names)
                assert after == {"messages": 0, "buckets": 0, "names": 0, "nodes": 0}
    finally:
        await st.close()
