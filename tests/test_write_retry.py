"""
Tests for the DB-write retry queue: a postgres bounce must buffer failed
archive writes and replay them on recovery instead of dropping packets
(observed in production: a DB restart permanently lost in-flight
mqtt_messages writes). Covers the queue mechanics, the retryable-error
classification (including the asyncpg exception-hierarchy traps), and the
write_mqtt_message integration end to end.
"""

import asyncio
import time

import asyncpg
import asyncpg.exceptions._base as asyncpg_base

from storage.db.postgres import PostgresStorage, _is_retryable_write_error
from storage.db.write_retry import WriteRetryQueue, WriteStillFailing


def run(coro):
    """Drive an async function without pytest-asyncio (not in requirements-dev)."""
    return asyncio.run(coro)


async def wait_for(predicate, timeout=2.0):
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("condition not met within timeout")
        await asyncio.sleep(0.005)


class Harness:
    """WriteRetryQueue wired to a controllable probe and a recording replay."""

    def __init__(self, db_up=True, replay=None, **queue_kwargs):
        self.db_up = db_up
        self.replayed = []
        self.probes = 0
        self.queue = WriteRetryQueue(
            replay or self._record,
            self._probe,
            base_delay_s=0.01,
            max_delay_s=0.02,
            **queue_kwargs,
        )

    async def _probe(self):
        self.probes += 1
        return self.db_up

    async def _record(self, kind, args, failed_at):
        self.replayed.append((kind, args))


class TestWriteRetryQueue:
    def test_replays_in_order_once_db_answers(self):
        async def scenario():
            h = Harness(db_up=True)
            h.queue.put("telemetry", ("a", {"n": 1}), failed_at=1.0)
            h.queue.put("telemetry", ("b", {"n": 2}), failed_at=2.0)
            await wait_for(lambda: len(h.replayed) == 2)
            assert [args[0] for _, args in h.replayed] == ["a", "b"]
            assert len(h.queue) == 0
        run(scenario())

    def test_backs_off_while_down_then_drains(self):
        async def scenario():
            h = Harness(db_up=False)
            h.queue.put("chat_message", ("a", {}), failed_at=1.0)
            await wait_for(lambda: h.probes >= 3)
            assert h.replayed == []
            assert len(h.queue) == 1
            h.db_up = True
            await wait_for(lambda: len(h.replayed) == 1)
            assert len(h.queue) == 0
        run(scenario())

    def test_bounded_drops_oldest_beyond_cap(self):
        async def scenario():
            h = Harness(db_up=False, max_items=3)
            for i in range(5):
                h.queue.put("telemetry", (f"n{i}", {}), failed_at=float(i))
            assert len(h.queue) == 3
            assert h.queue.drops_total == 2
            h.db_up = True
            await wait_for(lambda: len(h.replayed) == 3)
            assert [args[0] for _, args in h.replayed] == ["n2", "n3", "n4"]
        run(scenario())

    def test_still_failing_requeues_at_head_and_backs_off(self):
        """WriteStillFailing = DB dropped again mid-drain: the item must go
        back to the head (order preserved) and the drain must back off, not
        hot-spin."""
        async def scenario():
            attempts = []
            h = Harness(db_up=True)

            async def replay(kind, args, failed_at):
                attempts.append(args[0])
                if len(attempts) < 3:
                    raise WriteStillFailing("db dropped again")
                h.replayed.append((kind, args))

            h.queue._replay = replay
            h.queue.put("mqtt_message", ("first",), failed_at=1.0)
            h.queue.put("mqtt_message", ("second",), failed_at=2.0)
            await wait_for(lambda: len(h.replayed) == 2)
            # 'first' failed twice, was requeued at the head both times, and
            # still replayed before 'second'.
            assert attempts == ["first", "first", "first", "second"]
            # Each failed round required a fresh probe cycle — no hot spin.
            assert h.probes >= 3
        run(scenario())

    def test_unexpected_replay_error_drops_item_and_continues(self):
        async def scenario():
            seen = []

            async def replay(kind, args, failed_at):
                seen.append(args[0])
                if args[0] == "bad":
                    raise ValueError("boom")

            h = Harness(db_up=True, replay=replay)
            h.queue.put("telemetry", ("bad", {}), failed_at=1.0)
            h.queue.put("telemetry", ("good", {}), failed_at=2.0)
            await wait_for(lambda: seen == ["bad", "good"])
            assert len(h.queue) == 0  # 'bad' dropped, not retried forever
        run(scenario())

    def test_put_after_close_is_refused(self):
        async def scenario():
            h = Harness(db_up=True)
            await h.queue.close()
            assert h.queue.put("telemetry", ("a", {}), failed_at=1.0) is False
            assert len(h.queue) == 0
        run(scenario())


class TestRetryableClassification:
    def test_unavailability_errors_are_retryable(self):
        for e in (
            asyncpg.CannotConnectNowError("the database system is starting up"),
            asyncpg.AdminShutdownError("terminating connection"),
            asyncpg.TooManyConnectionsError("sorry, too many clients already"),
            asyncpg.InterfaceError("connection is closed"),
            ConnectionRefusedError("refused"),
            ConnectionResetError("reset"),
        ):
            assert _is_retryable_write_error(e), e

    def test_data_errors_are_not_retryable(self):
        for e in (
            asyncpg.DataError("server-side data error"),
            asyncpg.UniqueViolationError("duplicate key"),
            ValueError("bad"),
            KeyError("missing"),
        ):
            assert not _is_retryable_write_error(e), e

    def test_client_side_bind_error_is_not_retryable(self):
        """asyncpg's client-side bind failure ('invalid input for query
        argument') subclasses InterfaceError AND ValueError. Classifying it
        retryable would poison the queue: the same bad value fails on every
        replay, forever."""
        e = asyncpg_base.DataError("invalid input for query argument $15")
        assert isinstance(e, asyncpg.InterfaceError)  # guards the premise
        assert not _is_retryable_write_error(e)

    def test_command_timeout_is_not_retryable(self):
        """A reachable-but-slow DB (lock contention, vacuum) raises
        TimeoutError via command_timeout; replaying piles onto the stall and
        the statement may have committed server-side."""
        assert not _is_retryable_write_error(asyncio.TimeoutError())
        assert not _is_retryable_write_error(TimeoutError())


# ─────────────────────────────────────────────────────────────────────────────
# write_mqtt_message integration — outage buffers, recovery replays
# ─────────────────────────────────────────────────────────────────────────────


class FakeConn:
    def __init__(self):
        self.fetchvals = []

    async def fetchval(self, sql, *args):
        self.fetchvals.append(sql.strip().split()[0].upper())
        return 1 if "SELECT 1" in sql else 42

    async def execute(self, sql, *args):
        return None


class FlakyPool:
    """acquire() raises ConnectionRefusedError while .fail is True."""

    def __init__(self):
        self.fail = True
        self.conn = FakeConn()

    async def close(self):
        pass

    def acquire(self, timeout=None):
        pool = self

        class _CM:
            async def __aenter__(self):
                if pool.fail:
                    raise ConnectionRefusedError("db down")
                return pool.conn

            async def __aexit__(self, *exc):
                return False

        return _CM()


def make_storage():
    storage = PostgresStorage({
        # dedup off: exercise the plain-insert path without dedup fakes
        "storage": {"dedup_uplinks": False, "postgres": {"enabled": True}},
        "server": {"timezone": "UTC"},
    })
    storage.pool = FlakyPool()
    return storage


class TestWriteMqttMessageRetry:
    def test_outage_buffers_then_recovery_replays(self):
        async def scenario():
            storage = make_storage()
            msg = {"topic": "msh/US/2/e/LongFast/!aabbccdd", "text": "x"}
            row_id = await storage.write_mqtt_message(msg)
            assert row_id is None
            assert len(storage._write_retry) == 1

            storage.pool.fail = False
            await wait_for(lambda: len(storage._write_retry) == 0)
            assert "INSERT" in storage.pool.conn.fetchvals
            await storage.close()
        run(scenario())

    def test_snapshot_is_immune_to_caller_mutation(self):
        """handle_log keeps using the msg dict after the write call; the
        buffered copy must reflect the failure-time state."""
        async def scenario():
            storage = make_storage()
            msg = {"topic": "msh/x", "text": "original"}
            await storage.write_mqtt_message(msg)
            msg["text"] = "mutated-after-write"
            _, (queued,), _failed_at = storage._write_retry._items[0]
            assert queued["text"] == "original"
            await storage.close()
        run(scenario())

    def test_non_retryable_error_is_not_buffered(self):
        async def scenario():
            storage = make_storage()

            class BadPool(FlakyPool):
                def acquire(self, timeout=None):
                    raise ValueError("programming bug")

            storage.pool = BadPool()
            row_id = await storage.write_mqtt_message({"topic": "msh/x"})
            assert row_id is None
            assert len(storage._write_retry) == 0
            await storage.close()
        run(scenario())

    def test_replay_widens_dedup_lookback_by_item_age(self):
        """A packet buffered through an outage may have been canonicalized
        before it — the replay must look further back than dedup_window or it
        elects a duplicate canonical."""
        async def scenario():
            storage = make_storage()
            captured = {}

            async def fake_write(msg, *, _dedup_lookback_s=None):
                captured["lookback"] = _dedup_lookback_s

            storage.write_mqtt_message = fake_write
            await storage._replay_write(
                "mqtt_message", ({"topic": "msh/x"},), failed_at=time.time() - 1200)
            assert captured["lookback"] >= 1200 + storage.dedup_window - 5
            await storage.close()
        run(scenario())

    def test_replay_reraises_still_down_as_write_still_failing(self):
        """While replaying, a still-down DB must surface to the drain (which
        requeues at head + backs off) instead of re-buffering a fresh copy."""
        async def scenario():
            storage = make_storage()  # pool.fail is True
            try:
                await storage._replay_write(
                    "chat_message", ("aabbccdd", {"id": 1, "text": "x"}), failed_at=time.time())
            except WriteStillFailing:
                pass
            else:
                raise AssertionError("expected WriteStillFailing")
            # Nothing re-buffered: the drain owns the requeue.
            assert len(storage._write_retry) == 0
            await storage.close()
        run(scenario())
