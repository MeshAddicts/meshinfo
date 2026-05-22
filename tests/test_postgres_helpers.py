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

from storage.db.postgres import _json_default


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
