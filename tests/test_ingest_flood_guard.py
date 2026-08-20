"""
write_mqtt_message under a one-node flood: id-less packets dedup by
content, same-gateway repeats write nothing, the per-node limiter drops before
the pool is touched, and the (from, packet id) path is unchanged. Fake pool
and connection, no database.
"""

import asyncio
import json
import logging

from storage.db.postgres import PostgresStorage, _REPLAYING


def run(coro):
    return asyncio.run(coro)


class FakeConn:
    def __init__(self):
        self.rows = []          # mqtt_messages inserts (args tuples)
        self.receptions = []    # packet_receptions inserts (args tuples)
        self.lookups = 0        # _dedup_lookup_db calls
        self._seq = 0
        self.fail_receptions = False  # raise a non-retryable error on reception insert

    async def fetchval(self, sql, *args):
        if "INSERT INTO mqtt_messages" in sql:
            self._seq += 1
            self.rows.append(args)
            return self._seq
        if "INSERT INTO mqtt_topics" in sql:
            return 1
        return 1

    async def fetchrow(self, sql, *args):
        self.lookups += 1
        return None

    async def execute(self, sql, *args):
        if "INSERT INTO packet_receptions" in sql:
            if self.fail_receptions:
                raise ValueError("simulated DataError on reception")
            self.receptions.append(args)

    def transaction(self):
        conn = self

        class _Tx:
            async def __aenter__(self_inner):
                self_inner.mark = (len(conn.rows), len(conn.receptions))
                return None

            async def __aexit__(self_inner, exc_type, *exc):
                if exc_type is not None:  # rollback: discard rows written in the txn
                    del conn.rows[self_inner.mark[0]:]
                    del conn.receptions[self_inner.mark[1]:]
                return False
        return _Tx()


class FakePool:
    def __init__(self):
        self.conn = FakeConn()
        self.acquires = 0
        self.fail = False

    async def close(self):
        pass

    def acquire(self, timeout=None):
        pool = self

        class _CM:
            async def __aenter__(self):
                pool.acquires += 1
                if pool.fail:
                    raise ConnectionRefusedError("db down")
                return pool.conn

            async def __aexit__(self, *exc):
                return False
        return _CM()


def make_storage(**storage_cfg):
    cfg = {"dedup_uplinks": True, "max_packets_per_node_per_hour": 0,
           "postgres": {"enabled": True, "raise_on_write_error": False}}
    cfg.update(storage_cfg)
    storage = PostgresStorage({"storage": cfg, "server": {"timezone": "UTC"}})
    storage.pool = FakePool()
    return storage


ROGUE = "eba3d8e8"


def mapreport(ts, online=191, sender=ROGUE, **extra):
    """One MapReport copy as mqtt.py archives it: no packet id, self-uplinked."""
    m = {
        "from": ROGUE, "to": "ffffffff", "sender": sender, "timestamp": ts,
        "topic": "msh/US/bayarea/2/map/", "qos": 0, "retain": False,
        "channel": 31, "channel_name": "MediumFast", "type": "mapreport",
        "payload": {"altitude": 853, "firmware_version": "2.7.15", "hw_model": 37,
                    "latitude_i": 393412608, "longitude_i": -1210384384,
                    "long_name": "River Dragon - Base", "num_online_local_nodes": online,
                    "role": 11, "short_name": "RD"},
    }
    m.update(extra)
    return m


def rf_copy(packet_id, sender, rssi=-90, from_id="1f1ffa8b"):
    return {
        "from": from_id, "to": "ffffffff", "id": packet_id, "sender": sender,
        "topic": f"msh/US/2/e/LongFast/!{sender}", "timestamp": 1787025877,
        "rssi": rssi, "snr": 5.0, "hop_start": 3, "hop_limit": 2, "hops_away": 1,
        "type": "text", "payload": {"text": "hi"}, "qos": 0, "retain": False,
    }


class TestIdlessContentDedup:
    def test_incident_replay_collapses_to_distinct_content(self):
        """~49 copies/s for 10 min, timestamp ticking, 4 contents rotating ->
        4 canonical rows + 4 receptions, everything else writes nothing."""
        async def scenario():
            storage = make_storage()
            conn = storage.pool.conn
            written = 0
            for sec in range(600):
                for i in range(49):
                    rid = await storage.write_mqtt_message(
                        mapreport(1787025877 + sec, online=191 + ((sec * 49 + i) // 7000)))
                    if rid is not None:
                        written += 1
            # 600*49 = 29400 copies; online drifts through 191..195 -> 5 contents
            # (all inside one content window: the loop runs in well under 120 s)
            assert len(conn.rows) == 5
            assert len(conn.receptions) == 5
            assert written == 5
            assert storage._ingest_limiter.denied_total == 0
            assert conn.lookups == 0  # id-less path is cache-only
            await storage.close()
        run(scenario())

    def test_repeat_from_same_gateway_returns_none_without_touching_pool(self):
        async def scenario():
            storage = make_storage()
            first = await storage.write_mqtt_message(mapreport(1))
            assert first == 1
            acquires = storage.pool.acquires
            assert await storage.write_mqtt_message(mapreport(2)) is None
            assert storage.pool.acquires == acquires  # short-circuited pre-pool
            await storage.close()
        run(scenario())

    def test_second_gateway_gets_a_reception(self):
        async def scenario():
            storage = make_storage()
            conn = storage.pool.conn
            assert await storage.write_mqtt_message(mapreport(1)) == 1
            assert await storage.write_mqtt_message(mapreport(2, sender="aabbccdd")) == 1
            assert await storage.write_mqtt_message(mapreport(3, sender="aabbccdd")) is None
            assert len(conn.rows) == 1
            assert [r[1] for r in conn.receptions] == [ROGUE, "aabbccdd"]
            await storage.close()
        run(scenario())

    def test_canonical_row_carries_no_packet_id(self):
        async def scenario():
            storage = make_storage()
            await storage.write_mqtt_message(mapreport(1))
            (row,) = storage.pool.conn.rows
            topic, payload_text, qos, retain, ts, from_id, to_id, packet_id = row
            assert from_id == ROGUE and packet_id is None
            assert json.loads(payload_text)["type"] == "mapreport"
            await storage.close()
        run(scenario())

    def test_outage_does_not_buffer_repeat_copies(self):
        """Repeats of already-cached content are dropped before the pool during
        a DB outage, so they never reach the retry queue."""
        async def scenario():
            storage = make_storage()
            assert await storage.write_mqtt_message(mapreport(1)) == 1
            storage.pool.fail = True
            for i in range(200):
                assert await storage.write_mqtt_message(mapreport(2 + i)) is None
            assert len(storage._write_retry) == 0
            await storage.close()
        run(scenario())

    def test_dedup_disabled_means_guard_off(self):
        """Without dedup every copy is a row, so the caps would clip busy
        legit nodes: the guard is inactive and the config check warns."""
        async def scenario():
            storage = make_storage(dedup_uplinks=False, max_packets_per_node_per_minute=10)
            assert storage._ingest_limiter.enabled is False
            written = [await storage.write_mqtt_message(mapreport(i)) for i in range(50)]
            assert all(w is not None for w in written)
            assert len(storage.pool.conn.rows) == 50
            assert len(storage.pool.conn.receptions) == 0
            await storage.close()
        run(scenario())

    def test_content_window_is_the_short_one(self):
        async def scenario():
            storage = make_storage(dedup_window_seconds=900, content_dedup_window_seconds=120)
            assert storage._content_dedup_cache.window == 120.0
            assert storage._dedup_cache.window == 900.0
            await storage.close()
        run(scenario())

    def test_repeat_after_window_is_a_new_row(self):
        async def scenario():
            storage = make_storage(content_dedup_window_seconds=100)
            assert await storage.write_mqtt_message(mapreport(1)) == 1
            assert await storage.write_mqtt_message(mapreport(2)) is None
            # age the entry past the content window
            key = next(iter(storage._content_dedup_cache._entries))
            storage._content_dedup_cache._entries[key][0] = 0.0
            assert await storage.write_mqtt_message(mapreport(3)) == 2
            await storage.close()
        run(scenario())


class TestRateLimiterPlacement:
    def test_varying_content_capped_per_minute_before_pool(self):
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=5)
            for i in range(100):
                await storage.write_mqtt_message(mapreport(i, online=i))
            assert len(storage.pool.conn.rows) == 5
            assert storage.pool.acquires == 5  # dropped copies never reach the pool
            assert storage._ingest_limiter.denied_total == 95
            assert len(storage._write_retry) == 0
            await storage.close()
        run(scenario())

    def test_dedup_copies_do_not_count(self):
        """100 gateway copies of ONE packet with limit 1: canonical + 100
        receptions, nothing dropped — dense meshes are unaffected."""
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=1)
            conn = storage.pool.conn
            for i in range(100):
                assert await storage.write_mqtt_message(rf_copy(777, f"{i:08x}")) == 1
            assert len(conn.rows) == 1
            assert len(conn.receptions) == 100
            assert storage._ingest_limiter.denied_total == 0
            # the second distinct packet from that node this minute is over the cap
            assert await storage.write_mqtt_message(rf_copy(778, "00000001")) is None
            assert storage._ingest_limiter.denied_total == 1
            await storage.close()
        run(scenario())

    def test_other_nodes_unaffected(self):
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=1)
            assert await storage.write_mqtt_message(rf_copy(1, "aa", from_id="00000001")) == 1
            assert await storage.write_mqtt_message(rf_copy(2, "aa", from_id="00000001")) is None
            assert await storage.write_mqtt_message(rf_copy(3, "aa", from_id="00000002")) == 2
            await storage.close()
        run(scenario())

    def test_zero_disables(self):
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=0)
            for i in range(200):
                assert await storage.write_mqtt_message(mapreport(i, online=i)) == i + 1
            assert storage._ingest_limiter.denied_total == 0
            await storage.close()
        run(scenario())

    def test_replay_bypasses_limiter(self):
        """Buffered writes were admitted on first attempt; a post-outage drain
        burst of one node's packets must not be dropped by the limiter."""
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=1)
            token = _REPLAYING.set(True)
            try:
                for i in range(20):
                    assert await storage.write_mqtt_message(rf_copy(1000 + i, "aa")) == i + 1
            finally:
                _REPLAYING.reset(token)
            assert storage._ingest_limiter.denied_total == 0
            await storage.close()
        run(scenario())

    def test_messages_without_from_share_one_budget(self):
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=2)
            got = [await storage.write_mqtt_message({"topic": "msh/x", "text": str(i)}) for i in range(5)]
            assert got == [1, 2, None, None, None]
            await storage.close()
        run(scenario())

    def test_outage_copies_of_legit_node_are_buffered_not_dropped(self):
        """During an outage nothing is charged, so a busy node's copies all
        reach the retry buffer, exactly as before the guard."""
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=5)
            storage.pool.fail = True
            for i in range(300):
                assert await storage.write_mqtt_message(rf_copy(1000 + i // 30, f"{i % 30:08x}")) is None
            assert len(storage._write_retry) == 300
            assert storage._ingest_limiter.denied_total == 0
            await storage.close()
        run(scenario())

    def test_hour_tier_applies(self):
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=100, max_packets_per_node_per_hour=3)
            got = [await storage.write_mqtt_message(mapreport(i, online=i)) for i in range(6)]
            assert got == [1, 2, 3, None, None, None]
            await storage.close()
        run(scenario())

    def test_charge_happens_on_insert_only(self):
        """A copy that dedups into a reception must not spend the budget, and a
        rejected copy costs no DB round trip."""
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=1)
            assert await storage.write_mqtt_message(rf_copy(1, "aa")) == 1
            for i in range(10):
                assert await storage.write_mqtt_message(rf_copy(1, f"{i:08x}")) == 1
            assert storage._ingest_limiter.exhausted("1f1ffa8b") is True  # 1 row charged
            acquires = storage.pool.acquires
            assert await storage.write_mqtt_message(rf_copy(2, "aa")) is None
            assert storage.pool.acquires == acquires
            await storage.close()
        run(scenario())


class TestRealIdPath:
    def test_same_gateway_repeats_still_recorded_for_real_ids(self):
        """5.6% of real (packet, gateway) pairs legitimately repeat; that data
        stays. Only the id-less path suppresses same-gateway repeats."""
        async def scenario():
            storage = make_storage()
            conn = storage.pool.conn
            for _ in range(3):
                assert await storage.write_mqtt_message(rf_copy(42, "aabbccdd")) == 1
            assert len(conn.rows) == 1
            assert len(conn.receptions) == 3
            assert conn.lookups == 1  # DB fallback only on the first (cache miss)
            await storage.close()
        run(scenario())


class TestPeeksForHandlers:
    def test_idless_repeat_peek_matches_archive_decision(self):
        async def scenario():
            storage = make_storage()
            raw = dict(mapreport(1), decoded={"raw": "x"})  # as mqtt.py hands it to handlers
            assert storage.idless_repeat(raw) is False       # nothing archived yet
            assert await storage.write_mqtt_message(mapreport(1)) == 1
            assert storage.idless_repeat(dict(mapreport(2), decoded={"raw": "y"})) is True
            assert storage.idless_repeat(mapreport(3, sender="aabbccdd")) is False  # new gateway
            assert storage.idless_repeat(rf_copy(1, "aa")) is False                # real id: never
            assert storage.idless_repeat(mapreport(4, online=999)) is False        # new content
            await storage.close()
        run(scenario())

    def test_node_over_budget_peek(self):
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=1)
            assert storage.node_over_budget(ROGUE) is False
            await storage.write_mqtt_message(mapreport(1))
            assert storage.node_over_budget(ROGUE) is True
            assert storage.node_over_budget("!EBA3D8E8") is True  # normalized
            assert storage.node_over_budget("00000001") is False
            assert storage._ingest_limiter.denied_total == 0     # peeks never count
            await storage.close()
        run(scenario())


class TestReceptionCeiling:
    def test_replay_of_one_real_packet_is_capped(self):
        async def scenario():
            storage = make_storage()
            storage.max_receptions_per_packet = 5
            conn = storage.pool.conn
            assert await storage.write_mqtt_message(rf_copy(42, "aa")) == 1   # canonical + own reception
            got = [await storage.write_mqtt_message(rf_copy(42, "aa")) for _ in range(20)]
            assert got[:4] == [1, 1, 1, 1] and got[4:] == [None] * 16
            assert len(conn.rows) == 1
            assert len(conn.receptions) == 5
            acquires = storage.pool.acquires
            assert await storage.write_mqtt_message(rf_copy(42, "bb")) is None
            assert storage.pool.acquires == acquires  # capped pre-pool
            # a different packet from the same node is unaffected
            assert await storage.write_mqtt_message(rf_copy(43, "aa")) == 2
            await storage.close()
        run(scenario())

    def test_default_ceiling_is_far_above_legit(self):
        async def scenario():
            storage = make_storage()
            assert storage.max_receptions_per_packet >= 500  # legit max observed: 91
            for i in range(200):
                assert await storage.write_mqtt_message(rf_copy(7, f"{i:08x}")) == 1
            assert len(storage.pool.conn.receptions) == 200
            await storage.close()
        run(scenario())


async def _wait_for(pred, timeout=5.0):
    import time as _t
    deadline = _t.monotonic() + timeout
    while not pred():
        if _t.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.05)


class TestOutageBehavior:
    def test_outage_beyond_content_window_buffers_one_copy_per_content(self, caplog):
        """Outage past the content window: one copy per content is buffered
        (pinning a placeholder), the rest are dropped pre-pool."""
        async def scenario():
            storage = make_storage()
            conn = storage.pool.conn
            assert await storage.write_mqtt_message(mapreport(1)) == 1
            caplog.set_level(logging.WARNING, logger="storage.db.ingest_guard")
            storage.pool.fail = True
            key = next(iter(storage._content_dedup_cache._entries))
            storage._content_dedup_cache._entries[key][0] = 0.0  # window expired mid-outage
            acquires = storage.pool.acquires
            for i in range(100):
                assert await storage.write_mqtt_message(mapreport(10 + i)) is None
            assert len(storage._write_retry) == 1
            assert storage.pool.acquires == acquires + 1
            for i in range(50):  # a second content: one more buffered item
                assert await storage.write_mqtt_message(mapreport(200 + i, online=999)) is None
            assert len(storage._write_retry) == 2
            assert storage._ingest_limiter.denied_total == 0
            # handlers see the repeat too
            assert storage.idless_repeat(mapreport(300)) is True
            # the outage-time absorption is visible in the logs too
            guard_warnings = [r for r in caplog.records
                              if r.name == "storage.db.ingest_guard" and "keeps re-sending" in r.getMessage()]
            assert len(guard_warnings) == 1 and ROGUE in guard_warnings[0].getMessage()
            storage.pool.fail = False
            await _wait_for(lambda: len(storage._write_retry) == 0)
            assert len(conn.rows) == 3          # original + one canonical per buffered content
            assert len(conn.receptions) == 3
            # live copies now dedup against the replayed canonicals
            assert await storage.write_mqtt_message(mapreport(400)) is None
            assert await storage.write_mqtt_message(mapreport(401, online=999)) is None
            assert len(conn.rows) == 3
            await storage.close()
        run(scenario())

    def test_rollback_to_verbatim_fallback_charges_once(self):
        """A reception insert failing non-retryably rolls the canonical back and
        the copy is stored verbatim: one committed row must cost one unit."""
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=4)
            conn = storage.pool.conn
            conn.fail_receptions = True
            got = [await storage.write_mqtt_message(rf_copy(100 + i, "aa")) for i in range(6)]
            assert [g is not None for g in got] == [True] * 4 + [False] * 2
            assert len(conn.rows) == 4
            assert storage._ingest_limiter.denied_total == 2
            await storage.close()
        run(scenario())

    def test_replay_inserts_are_not_charged(self):
        async def scenario():
            storage = make_storage(max_packets_per_node_per_minute=2)
            token = _REPLAYING.set(True)
            try:
                for i in range(5):
                    assert await storage.write_mqtt_message(rf_copy(500 + i, "aa")) == i + 1
            finally:
                _REPLAYING.reset(token)
            assert storage._ingest_limiter.exhausted("1f1ffa8b") is False
            await storage.close()
        run(scenario())


class TestFloodIsLogged:
    def test_incident_absorption_emits_a_warning(self, caplog):
        """The incident shape never trips the limiter — the absorption WARNING
        is the only sign in the logs that a node is looping."""
        async def scenario():
            storage = make_storage()
            with caplog.at_level(logging.WARNING, logger="storage.db.ingest_guard"):
                for i in range(60):
                    await storage.write_mqtt_message(mapreport(i))
            msgs = [r.getMessage() for r in caplog.records]
            assert len(msgs) == 1 and "keeps re-sending identical packets" in msgs[0]
            assert ROGUE in msgs[0]
            await storage.close()
        run(scenario())

    def test_normal_traffic_logs_nothing(self, caplog):
        async def scenario():
            storage = make_storage()
            with caplog.at_level(logging.INFO, logger="storage.db.ingest_guard"):
                for i in range(10):
                    await storage.write_mqtt_message(rf_copy(700 + i, f"{i:08x}"))
                await storage.write_mqtt_message(mapreport(1))
                await storage.write_mqtt_message(mapreport(2))  # one absorbed copy
            assert caplog.records == []
            await storage.close()
        run(scenario())

    def test_replay_absorption_is_not_logged(self, caplog):
        """The drain re-delivering outage-era repeats isn't a live flood."""
        async def scenario():
            storage = make_storage()
            assert await storage.write_mqtt_message(mapreport(1)) == 1
            token = _REPLAYING.set(True)
            try:
                with caplog.at_level(logging.WARNING, logger="storage.db.ingest_guard"):
                    for i in range(100):
                        assert await storage.write_mqtt_message(mapreport(2 + i)) is None
            finally:
                _REPLAYING.reset(token)
            assert caplog.records == []
            await storage.close()
        run(scenario())
