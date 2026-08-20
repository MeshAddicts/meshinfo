"""
Tests for storage.db.ingest_guard.NodeRateLimiter: the per-node minute/hour
budget of new archive rows that keeps one looping node from owning the disk.
"""

import logging

from storage.db.ingest_guard import NO_FROM, NodeRateLimiter, SuppressedCopyLog


def _spend(lim, node, n, now):
    """Try n rows: allow() then charge() on success. Returns rows created."""
    made = 0
    for _ in range(n):
        if lim.allow(node, now=now):
            lim.charge(node, now=now)
            made += 1
    return made


class TestNodeRateLimiter:
    def test_allows_up_to_minute_limit_then_denies(self):
        lim = NodeRateLimiter(per_minute=3, per_hour=0)
        assert _spend(lim, "aa", 10, now=0.0) == 3
        assert lim.denied_total == 7

    def test_minute_window_rolls_over(self):
        lim = NodeRateLimiter(per_minute=2, per_hour=0)
        assert _spend(lim, "aa", 5, now=0.0) == 2
        assert lim.allow("aa", now=59.9) is False
        assert lim.allow("aa", now=60.0) is True
        assert _spend(lim, "aa", 5, now=60.0) == 2

    def test_hour_tier_caps_sustained_rate(self):
        lim = NodeRateLimiter(per_minute=60, per_hour=100)
        made = sum(_spend(lim, "aa", 60, now=float(m * 60)) for m in range(60))
        assert made == 100  # 60/min allowed, but only 100 in the hour
        assert lim.allow("aa", now=3600.0) is True  # hour rolled over

    def test_legit_profile_never_denied(self):
        # Measured legit peaks: 28/min, 39/5min, 55/15min, 119/hour.
        lim = NodeRateLimiter(per_minute=60, per_hour=600)
        assert _spend(lim, "aa", 28, now=0.0) == 28
        for m in range(1, 60):
            assert _spend(lim, "aa", 2, now=float(m * 60)) == 2
        assert lim.denied_total == 0

    def test_nodes_are_independent(self):
        lim = NodeRateLimiter(per_minute=1, per_hour=0)
        assert _spend(lim, "aa", 2, now=0.0) == 1
        assert lim.allow("bb", now=0.0) is True

    def test_zero_disables(self):
        lim = NodeRateLimiter(per_minute=0, per_hour=0)
        assert lim.enabled is False
        assert _spend(lim, "aa", 1000, now=0.0) == 1000
        assert lim.denied_total == 0
        assert lim._nodes == {}

    def test_none_node_shares_one_bucket(self):
        lim = NodeRateLimiter(per_minute=2, per_hour=0)
        assert _spend(lim, None, 5, now=0.0) == 2
        assert lim.exhausted(None, now=0.0) is True
        assert NO_FROM in lim._nodes

    def test_charge_only_counts_rows_not_attempts(self):
        """Admission is a peek: copies that never become rows cost nothing,
        so a DB outage (no inserts) never spends the budget."""
        lim = NodeRateLimiter(per_minute=1, per_hour=0)
        for _ in range(100):
            assert lim.allow("aa", now=0.0) is True
        assert lim.exhausted("aa", now=0.0) is False
        lim.charge("aa", now=0.0)
        assert lim.allow("aa", now=0.0) is False

    def test_exhausted_is_a_pure_peek(self, caplog):
        lim = NodeRateLimiter(per_minute=1, per_hour=0)
        lim.charge("aa", now=0.0)
        with caplog.at_level(logging.WARNING, logger="storage.db.ingest_guard"):
            for _ in range(5):
                assert lim.exhausted("aa", now=1.0) is True
        assert lim.denied_total == 0
        assert caplog.records == []

    def test_incident_pattern_drops_almost_everything(self):
        # 49 msg/s of distinct content for 10 minutes: 60/min, 600/h.
        lim = NodeRateLimiter(per_minute=60, per_hour=600)
        made = sum(_spend(lim, "eba3d8e8", 49, now=float(sec)) for sec in range(600))
        assert made == 600
        assert lim.denied_total == 600 * 49 - 600

    def test_warning_once_on_start_then_per_minute_summary(self, caplog):
        lim = NodeRateLimiter(per_minute=1, per_hour=0)
        with caplog.at_level(logging.WARNING, logger="storage.db.ingest_guard"):
            _spend(lim, "eba3d8e8", 50, now=0.0)      # start of flood: one line
            _spend(lim, "eba3d8e8", 50, now=30.0)     # same window: silent
            _spend(lim, "eba3d8e8", 50, now=60.0)     # rollover: summary of last window
            _spend(lim, "eba3d8e8", 50, now=120.0)    # rollover: summary
        msgs = [r.getMessage() for r in caplog.records]
        assert len(msgs) == 3, msgs
        assert msgs[0].startswith("Node eba3d8e8 exceeded 1/min new archive rows")
        assert 'ingest_denylist' in msgs[0] and '"eba3d8e8"' in msgs[0]
        assert "/hour" not in msgs[0]  # disabled tier is not mentioned
        assert "dropped 99 writes in the last minute" in msgs[1]
        assert "dropped 49 writes in the last minute" in msgs[2]

    def test_quiet_window_resets_start_warning(self, caplog):
        lim = NodeRateLimiter(per_minute=1, per_hour=0)
        with caplog.at_level(logging.WARNING, logger="storage.db.ingest_guard"):
            _spend(lim, "aa", 3, now=0.0)          # start warning
            assert lim.allow("aa", now=100.0)      # clean window (summary of the previous)
            _spend(lim, "aa", 3, now=200.0)        # flood again: start warning again
        msgs = [r.getMessage() for r in caplog.records]
        assert [m.startswith("Node aa exceeded") for m in msgs] == [True, False, True]

    def test_purge_bounds_memory(self):
        lim = NodeRateLimiter(per_minute=5, per_hour=0, max_nodes=3)
        for i in range(3):
            lim.charge(f"n{i}", now=0.0)
        assert len(lim._nodes) == 3
        lim.charge("n3", now=3601.0)  # all three are stale -> purged, then n3 added
        assert set(lim._nodes) == {"n3"}


class TestSuppressedCopyLog:
    def _flood(self, log, node, n, now):
        for _ in range(n):
            log.note(node, now=now)

    def test_warns_once_on_crossing_then_summary_per_window(self, caplog):
        log = SuppressedCopyLog(threshold=30)
        with caplog.at_level(logging.WARNING, logger="storage.db.ingest_guard"):
            self._flood(log, "eba3d8e8", 2900, now=0.0)     # crossing: one line
            self._flood(log, "eba3d8e8", 2900, now=60.0)    # rollover: summary, no re-cross line
            self._flood(log, "eba3d8e8", 2900, now=120.0)   # rollover: summary
        msgs = [r.getMessage() for r in caplog.records]
        assert len(msgs) == 3, msgs
        assert "keeps re-sending identical packets" in msgs[0]
        assert 'ingest_denylist' in msgs[0] and '"eba3d8e8"' in msgs[0]
        assert "2900 duplicate copies absorbed" in msgs[1]
        assert "2900 duplicate copies absorbed" in msgs[2]

    def test_below_threshold_stays_silent(self, caplog):
        log = SuppressedCopyLog(threshold=30)
        with caplog.at_level(logging.WARNING, logger="storage.db.ingest_guard"):
            self._flood(log, "aa", 29, now=0.0)
            self._flood(log, "aa", 29, now=60.0)
        assert caplog.records == []

    def test_quiet_window_re_arms_the_crossing_warning(self, caplog):
        log = SuppressedCopyLog(threshold=5)
        with caplog.at_level(logging.WARNING, logger="storage.db.ingest_guard"):
            self._flood(log, "aa", 10, now=0.0)     # cross
            log.note("aa", now=100.0)               # quiet-ish window (summary of the last)
            self._flood(log, "aa", 10, now=200.0)   # cross again
        msgs = [r.getMessage() for r in caplog.records]
        assert ["keeps re-sending" in m for m in msgs] == [True, False, True]

    def test_quiet_gap_re_arms_and_skips_stale_summary(self, caplog):
        """A summary is only for a window that just ended; after a long gap the
        crossing warning fires again instead of a mislabeled old count."""
        log = SuppressedCopyLog(threshold=30)
        with caplog.at_level(logging.WARNING, logger="storage.db.ingest_guard"):
            self._flood(log, "aa", 100, now=0.0)    # crossing line
            self._flood(log, "aa", 100, now=600.0)  # 10 min later: no stale summary, re-cross
        msgs = [r.getMessage() for r in caplog.records]
        assert len(msgs) == 2, msgs
        assert all("keeps re-sending" in m for m in msgs)

    def test_none_node_and_memory_bound(self):
        log = SuppressedCopyLog(threshold=5, max_nodes=2)
        log.note(None, now=0.0)
        assert log._nodes == {}
        log.note("a", now=0.0); log.note("b", now=0.0)
        log.note("c", now=61.0)  # stale entries purged
        assert set(log._nodes) == {"c"}
