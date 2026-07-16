"""
Tests for storage.db.postgres._json_default — the json.dumps fallback that
keeps JSONB writes from silently failing when a payload carries a datetime
(the JSON-decoder path coerces last_seen/last_geocoding into datetime objects).
"""

import datetime
import json


from storage.db.postgres import (
    PostgresStorage,
    _decode_cursor,
    _encode_cursor,
    _finite_or_none,
    _json_default,
    _month_partition_specs,
)


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


class TestFiniteOrNone:
    """Non-finite telemetry values must become NULL, not fail the whole
    node write. The exact failure shape from production: proto3 JSON
    renders a sensor's NaN float as the string "NaN", which asyncpg
    rejects for numeric columns ('must be real number, not str')."""

    def test_nan_string_becomes_none(self):
        assert _finite_or_none("NaN") is None

    def test_infinity_strings_become_none(self):
        assert _finite_or_none("Infinity") is None
        assert _finite_or_none("-Infinity") is None

    def test_nan_float_becomes_none(self):
        assert _finite_or_none(float("nan")) is None

    def test_infinite_floats_become_none(self):
        assert _finite_or_none(float("inf")) is None
        assert _finite_or_none(float("-inf")) is None

    def test_finite_values_pass_through(self):
        assert _finite_or_none(3.7) == 3.7
        assert _finite_or_none(87) == 87
        assert _finite_or_none(0) == 0
        assert _finite_or_none(None) is None

    def test_non_numeric_values_pass_through(self):
        # Not this helper's job to coerce or reject other bad input.
        assert _finite_or_none("not-a-number") == "not-a-number"


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


class TestBuildMessagePage:
    """PostgresStorage._build_mqtt_message_page — row parsing + keyset cursor."""

    @staticmethod
    def _row(row_id, payload, created_at, topic="msh/x", ts=1000):
        return {"id": row_id, "topic": topic, "payload": payload, "qos": 0,
                "retain": False, "timestamp": ts, "created_at": created_at}

    def test_injects_mqtt_row_id(self):
        ca = datetime.datetime(2026, 5, 1, tzinfo=datetime.timezone.utc)
        rows = [self._row(7, '{"type": "text", "from": "abcd"}', ca)]
        page = PostgresStorage._build_mqtt_message_page(rows, 10)
        assert page["messages"][0]["mqtt_row_id"] == 7
        assert page["messages"][0]["type"] == "text"
        assert page["next_cursor"] is None  # fewer rows than limit -> last page

    def test_has_more_sets_cursor_and_trims_to_limit(self):
        ca = datetime.datetime(2026, 5, 1, tzinfo=datetime.timezone.utc)
        # limit 2, fetched 3 (the +1 sentinel) -> 2 returned, cursor at last returned
        rows = [self._row(i, '{"type": "position"}', ca) for i in (3, 2, 1)]
        page = PostgresStorage._build_mqtt_message_page(rows, 2)
        assert len(page["messages"]) == 2
        assert _decode_cursor(page["next_cursor"]) == (ca, 2)

    def test_payload_topic_and_timestamp_win_over_row_columns(self):
        ca = datetime.datetime(2026, 5, 1, tzinfo=datetime.timezone.utc)
        rows = [self._row(1, '{"topic": "payload-topic", "timestamp": 42}', ca,
                          topic="row-topic", ts=999)]
        msg = PostgresStorage._build_mqtt_message_page(rows, 10)["messages"][0]
        assert msg["topic"] == "payload-topic"
        assert msg["timestamp"] == 42


class TestMonthPartitionSpecs:
    """_month_partition_specs — names + half-open [lo, hi) bounds for the
    mqtt_messages monthly partitions."""

    def test_current_plus_two_months(self):
        specs = _month_partition_specs(datetime.date(2026, 5, 15), 2)
        assert specs == [
            ("mqtt_messages_2026_05", "2026-05-01", "2026-06-01"),
            ("mqtt_messages_2026_06", "2026-06-01", "2026-07-01"),
            ("mqtt_messages_2026_07", "2026-07-01", "2026-08-01"),
        ]

    def test_months_ahead_zero_is_current_month_only(self):
        specs = _month_partition_specs(datetime.date(2026, 5, 1), 0)
        assert specs == [("mqtt_messages_2026_05", "2026-05-01", "2026-06-01")]

    def test_crosses_year_boundary(self):
        specs = _month_partition_specs(datetime.date(2026, 12, 20), 1)
        assert specs == [
            ("mqtt_messages_2026_12", "2026-12-01", "2027-01-01"),
            ("mqtt_messages_2027_01", "2027-01-01", "2027-02-01"),
        ]

    def test_ranges_are_contiguous_and_half_open(self):
        specs = _month_partition_specs(datetime.date(2026, 1, 31), 5)
        for prev, nxt in zip(specs, specs[1:]):
            assert prev[2] == nxt[1]  # each hi is the next lo — no gaps, no overlap
