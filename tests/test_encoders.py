"""
Tests for encoders._JSONDecoder — `!` stripping limited to id-style keys
(text payloads preserved), and `fromisoformat` guarded against NULL DB rows.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from encoders import _JSONDecoder


def _decode(raw: str):
    return json.loads(raw, cls=_JSONDecoder)


class TestBangStripping:
    def test_id_strips_bang(self):
        assert _decode('{"id": "!bafb8e9a"}') == {"id": "bafb8e9a"}

    def test_sender_strips_bang(self):
        assert _decode('{"sender": "!67ea9400"}') == {"sender": "67ea9400"}

    def test_from_to_strip_bang(self):
        assert _decode('{"from": "!a1", "to": "!ff"}') == {"from": "a1", "to": "ff"}

    def test_text_preserves_bang(self):
        msg = '{"payload": {"text": "Hello, mesh!"}}'
        assert _decode(msg) == {"payload": {"text": "Hello, mesh!"}}

    def test_longname_preserves_bang(self):
        assert _decode('{"longname": "Yes!"}') == {"longname": "Yes!"}

    def test_non_string_id_passes_through(self):
        # Some publishers send id as int.
        assert _decode('{"id": 12345}') == {"id": 12345}


class TestDateParsing:
    def test_iso_string_parsed(self):
        from datetime import datetime
        out = _decode('{"last_seen": "2026-05-15T12:34:56"}')
        assert isinstance(out["last_seen"], datetime)

    def test_none_does_not_crash(self):
        """DB rows can carry NULL last_seen; must not raise."""
        assert _decode('{"last_seen": null}') == {"last_seen": None}

    def test_invalid_format_does_not_crash(self):
        assert _decode('{"last_geocoding": "not-a-date"}') == {"last_geocoding": None}
