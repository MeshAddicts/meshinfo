"""
Tests for API.api small pure helpers — node-id coercion (L11) and range
parsing (L6 covered the dead-code/'all'-override bug downstream of _parse_range,
but _parse_range itself is also worth a quick lock-down).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.api import API


class TestCoerceNodeId:
    def test_decimal_to_hex(self):
        # 3137048218 = 0xbafb8e9a — the int form Meshtastic sends for `from`.
        assert API._coerce_node_id("3137048218") == "bafb8e9a"

    def test_hex_pass_through_lowercased(self):
        assert API._coerce_node_id("BAFB8E9A") == "bafb8e9a"

    def test_bang_stripped(self):
        assert API._coerce_node_id("!bafb8e9a") == "bafb8e9a"

    def test_invalid_input_passes_through(self):
        # Garbage in → garbage out → 404 downstream. Helper doesn't validate.
        assert API._coerce_node_id("not-an-id") == "not-an-id"


class TestParseRange:
    def test_hours(self):
        assert API._parse_range("1h") == 3600
        assert API._parse_range("24h") == 86400

    def test_days(self):
        assert API._parse_range("7d") == 7 * 86400

    def test_all_returns_none(self):
        assert API._parse_range("all") is None

    def test_missing_returns_none(self):
        assert API._parse_range(None) is None
        assert API._parse_range("") is None

    def test_invalid_unit_defaults_to_24h(self):
        assert API._parse_range("garbage") == 24 * 3600

    def test_negative_or_zero_defaults_to_24h(self):
        assert API._parse_range("0h") == 24 * 3600
