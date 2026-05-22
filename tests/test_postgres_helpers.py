"""
Tests for storage.db.postgres._json_default — the json.dumps fallback that
keeps JSONB writes from silently failing when a payload carries a datetime
(the JSON-decoder path coerces last_seen/last_geocoding into datetime objects).
"""

import datetime
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage.db.postgres import _decode_cursor, _encode_cursor, _json_default


class TestJsonDefault:
    def test_datetime_to_isoformat(self):
        dt = datetime.datetime(2026, 5, 21, 12, 34, 56)
        assert _json_default(dt) == "2026-05-21T12:34:56"

    def test_date_to_isoformat(self):
        assert _json_default(datetime.date(2026, 5, 21)) == "2026-05-21"

    def test_time_to_isoformat(self):
        assert _json_default(datetime.time(12, 34, 56)) == "12:34:56"

    def test_timedelta_to_seconds(self):
        assert _json_default(datetime.timedelta(minutes=2)) == 120.0

    def test_unknown_type_falls_back_to_str(self):
        assert _json_default(object()).startswith("<object object")


class TestDumpsWithDefault:
    def test_payload_with_datetime_serializes(self):
        """The exact failure shape from production: a telemetry payload with a
        datetime must serialize instead of raising and dropping the write."""
        payload = {"battery_level": 80, "last_seen": datetime.datetime(2026, 5, 21, 0, 0, 0)}
        out = json.loads(json.dumps(payload, default=_json_default))
        assert out["battery_level"] == 80
        assert out["last_seen"] == "2026-05-21T00:00:00"

    def test_plain_dumps_still_raises_without_default(self):
        """Guards the premise — a bare json.dumps is what failed before."""
        import pytest

        with pytest.raises(TypeError):
            json.dumps({"ts": datetime.datetime.now()})


class TestCursorCodec:
    """Keyset-pagination cursor for mqtt_messages — see _encode_cursor/_decode_cursor."""

    def test_roundtrip(self):
        ts = datetime.datetime(2026, 5, 21, 12, 0, 0, tzinfo=datetime.timezone.utc)
        cursor = _encode_cursor(ts, 4242)
        assert isinstance(cursor, str)
        assert _decode_cursor(cursor) == (ts, 4242)

    def test_roundtrip_preserves_microseconds(self):
        # Real created_at values carry microseconds; the tiebreaker must survive.
        ts = datetime.datetime(2026, 1, 25, 4, 3, 47, 136380, tzinfo=datetime.timezone.utc)
        assert _decode_cursor(_encode_cursor(ts, 1)) == (ts, 1)

    def test_decode_garbage_returns_none(self):
        assert _decode_cursor("not-a-real-cursor") is None

    def test_decode_empty_returns_none(self):
        assert _decode_cursor("") is None

    def test_decode_valid_base64_wrong_shape_returns_none(self):
        import base64
        bad = base64.urlsafe_b64encode(b"missing-the-id-separator").decode()
        assert _decode_cursor(bad) is None
