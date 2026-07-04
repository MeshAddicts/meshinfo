"""
Tests for the small pure helpers in api.api — node-id coercion + range parsing.
"""


from api.api import API


class TestCoerceNodeId:
    def test_decimal_to_hex(self):
        # 3137048218 = 0xbafb8e9a — Meshtastic's int form for `from`.
        assert API._coerce_node_id("3137048218") == "bafb8e9a"

    def test_hex_pass_through_lowercased(self):
        assert API._coerce_node_id("BAFB8E9A") == "bafb8e9a"

    def test_bang_stripped(self):
        assert API._coerce_node_id("!bafb8e9a") == "bafb8e9a"

    def test_short_hex_left_padded(self):
        # Short hex would otherwise miss the VARCHAR(8) row.
        assert API._coerce_node_id("abc") == "00000abc"
        assert API._coerce_node_id("!abc") == "00000abc"

    def test_all_digit_hex_treated_as_hex_not_decimal(self):
        # 8 chars of all digits is still a valid hex id; must not convert via int().
        assert API._coerce_node_id("99005060") == "99005060"

    def test_invalid_input_passes_through(self):
        assert API._coerce_node_id("not-an-id") == "not-an-id"

    def test_overflow_decimal_passes_through(self):
        assert API._coerce_node_id("999999999999") == "999999999999"

    def test_negative_decimal_passes_through(self):
        assert API._coerce_node_id("-1") == "-1"


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
