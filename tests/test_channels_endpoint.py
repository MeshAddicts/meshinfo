"""
Tests for the /v1/channels surface: the shared chat-range vocabulary and
query_channels' fail-safe fallbacks. The endpoint itself is a thin composition
of these two pieces (see api/api.py channels_endpoint).
"""

import asyncio

from api.api import API
from storage.db.postgres import PostgresStorage


class TestChatRangeSeconds:
    def test_known_windows(self):
        assert API._chat_range_seconds("1h") == 3600
        assert API._chat_range_seconds("24h") == 86400
        assert API._chat_range_seconds("7d") == 604800

    def test_all_means_no_window(self):
        # Membership semantics: "all" maps to None on purpose — a .get()
        # default would silently turn it into 24h.
        assert API._chat_range_seconds("all") is None

    def test_absent_and_unknown_default_to_24h(self):
        assert API._chat_range_seconds(None) == 86400
        assert API._chat_range_seconds("") == 86400
        assert API._chat_range_seconds("3w") == 86400
        assert API._chat_range_seconds("ALL") == 86400  # case-sensitive vocabulary


class TestQueryChannelsFallbacks:
    def _storage_without_pool(self) -> PostgresStorage:
        s = PostgresStorage.__new__(PostgresStorage)
        s.enabled = True
        s.pool = None
        return s

    def test_disabled_storage_returns_empty(self):
        s = PostgresStorage.__new__(PostgresStorage)
        s.enabled = False
        s.pool = None
        assert asyncio.run(s.query_channels()) == {}

    def test_no_pool_returns_empty(self):
        # Pool not up yet (startup race) — the endpoint must degrade to an
        # empty channels map, never raise.
        s = self._storage_without_pool()
        assert asyncio.run(s.query_channels()) == {}
        assert asyncio.run(s.query_channels(range_seconds=3600)) == {}
