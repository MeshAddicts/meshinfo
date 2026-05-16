"""
Tests for mqtt._normalize_node_id — the canonical node-id coercion at the
heart of the Group A "Unknown nodes" fix. A wrong normalization here would
silently fork node identity across decoder paths.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mqtt import _normalize_node_id


class TestIntInputs:
    def test_typical_uint32(self):
        # 0x67ea9400 = 1743463424
        assert _normalize_node_id(0x67EA9400) == "67ea9400"

    def test_small_int_left_pads_to_8_chars(self):
        # convert_node_id_from_int_to_hex(1) returns "00000001"
        assert _normalize_node_id(1) == "00000001"

    def test_zero(self):
        assert _normalize_node_id(0) == "00000000"


class TestStringInputs:
    def test_lowercase_hex_pass_through(self):
        assert _normalize_node_id("67ea9400") == "67ea9400"

    def test_uppercase_lowered(self):
        assert _normalize_node_id("67EA9400") == "67ea9400"

    def test_leading_bang_stripped(self):
        assert _normalize_node_id("!67ea9400") == "67ea9400"

    def test_short_hex_left_padded(self):
        # A short id from a JSON publisher that elides leading zeros.
        assert _normalize_node_id("abc") == "00000abc"

    def test_mixed_case_with_bang(self):
        assert _normalize_node_id("!67Ea9400") == "67ea9400"


class TestRejected:
    def test_none(self):
        assert _normalize_node_id(None) is None

    def test_empty_string(self):
        assert _normalize_node_id("") is None

    def test_too_long(self):
        # 9 hex chars overflows the 8-char schema.
        assert _normalize_node_id("123456789") is None

    def test_non_hex_chars(self):
        assert _normalize_node_id("xyz!") is None

    def test_float_rejected(self):
        # Floats can sneak in from JSON if a publisher mis-serializes.
        assert _normalize_node_id(3.14) is None

    def test_bool_rejected(self):
        # bool is an int subclass in Python; make sure the normalizer accepts
        # True as int(1) — this is the documented behaviour even if weird.
        assert _normalize_node_id(True) == "00000001"
        assert _normalize_node_id(False) == "00000000"


class TestIdentityStable:
    """Same node id from different decoder paths must normalize identically."""

    def test_int_and_string_agree(self):
        assert _normalize_node_id(0x67EA9400) == _normalize_node_id("67ea9400")

    def test_int_and_bang_string_agree(self):
        assert _normalize_node_id(0x67EA9400) == _normalize_node_id("!67ea9400")

    def test_uppercase_and_lowercase_agree(self):
        assert _normalize_node_id("67EA9400") == _normalize_node_id("67ea9400")
