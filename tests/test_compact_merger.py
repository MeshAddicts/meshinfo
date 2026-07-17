"""
Tests for scripts/compact_mqtt_partitions.py's streaming Merger — the
historical-partition counterpart of ingest dedup (#526).
"""

import datetime
import importlib.util
import json
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "compact_mqtt_partitions",
    Path(__file__).resolve().parents[1] / "scripts" / "compact_mqtt_partitions.py",
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
Merger = _mod.Merger
MQTT_COLUMNS = _mod.MQTT_COLUMNS

T0 = datetime.datetime(2026, 5, 10, 12, 0, 0, tzinfo=datetime.timezone.utc)


def _row(row_id, offset_s, payload_dict=None, payload_text=None, from_node_id=None):
    payload = payload_text if payload_text is not None else json.dumps(payload_dict)
    return {
        "id": row_id,
        "topic": (payload_dict or {}).get("topic", "msh/US/2/e/LongFast/!aabbccdd"),
        "payload": payload,
        "qos": 0,
        "retain": False,
        "timestamp": 1779438295,
        "created_at": T0 + datetime.timedelta(seconds=offset_s),
        "from_node_id": from_node_id,
        "to_node_id": "ffffffff",
        "packet_id": None,
    }


def _pkt(sender, rssi, pid=777):
    return {
        "from": "1f1ffa8b", "to": "ffffffff", "id": pid, "type": "nodeinfo",
        "sender": sender, "topic": f"msh/US/2/e/LongFast/!{sender}",
        "rx_rssi": rssi, "rx_snr": 5.0, "rx_time": 1779438295,
        "hop_limit": 3, "hop_start": 5,
    }


class TestMerger:
    def test_copies_within_window_collapse(self):
        m = Merger(900)
        m.feed(_row(1, 0, _pkt("aaaaaaaa", -60), from_node_id="1f1ffa8b"))
        m.feed(_row(2, 5, _pkt("bbbbbbbb", -80), from_node_id="1f1ffa8b"))
        m.feed(_row(3, 9, _pkt("cccccccc", -90), from_node_id="1f1ffa8b"))
        assert m.stats == {"source": 3, "canonical": 1, "duplicate": 2, "passthrough": 0}
        assert len(m.canonical_rows) == 1 and len(m.reception_rows) == 3
        # Canonical row keeps the first copy's id and verbatim payload text.
        row = dict(zip(MQTT_COLUMNS, m.canonical_rows[0]))
        assert row["id"] == 1 and json.loads(row["payload"])["sender"] == "aaaaaaaa"
        assert row["packet_id"] == 777
        # Duplicate receptions reference the canonical row id.
        assert {r[0] for r in m.reception_rows} == {1}

    def test_same_key_after_window_starts_new_canonical(self):
        m = Merger(900)
        m.feed(_row(1, 0, _pkt("aaaaaaaa", -60), from_node_id="1f1ffa8b"))
        m.feed(_row(2, 901, _pkt("bbbbbbbb", -80), from_node_id="1f1ffa8b"))
        assert m.stats["canonical"] == 2 and m.stats["duplicate"] == 0

    def test_row_without_packet_id_passes_through(self):
        m = Merger(900)
        m.feed(_row(1, 0, {"from": "1f1ffa8b", "type": "mapreport"}, from_node_id="1f1ffa8b"))
        assert m.stats["passthrough"] == 1
        assert len(m.canonical_rows) == 1 and len(m.reception_rows) == 0

    def test_unparseable_payload_passes_through(self):
        m = Merger(900)
        m.feed(_row(1, 0, payload_text="b64:AAECAw=="))
        assert m.stats["passthrough"] == 1

    def test_nul_escape_extras_pass_through(self):
        # A copy whose diff would embed \u0000 can't live in jsonb extras.
        base = _pkt("aaaaaaaa", -60)
        m = Merger(900)
        m.feed(_row(1, 0, base, from_node_id="1f1ffa8b"))
        odd = dict(_pkt("bbbbbbbb", -70))
        odd["weird"] = "x\x00y"
        m.feed(_row(2, 5, odd, from_node_id="1f1ffa8b"))
        assert m.stats["duplicate"] == 0 and m.stats["passthrough"] == 1

    def test_from_node_id_falls_back_to_payload(self):
        m = Merger(900)
        m.feed(_row(1, 0, _pkt("aaaaaaaa", -60), from_node_id=None))
        m.feed(_row(2, 5, _pkt("bbbbbbbb", -80), from_node_id=None))
        assert m.stats["canonical"] == 1 and m.stats["duplicate"] == 1

    def test_accounting_invariant(self):
        # source == passthrough + receptions; staging == canonical + passthrough.
        m = Merger(900)
        for i in range(4):
            m.feed(_row(i + 1, i, _pkt(f"{i:08x}", -60 - i), from_node_id="1f1ffa8b"))
        m.feed(_row(9, 20, {"from": "x", "type": "mapreport"}, from_node_id="deadbeef"))
        s = m.stats
        assert s["source"] == s["passthrough"] + s["canonical"] + s["duplicate"]
        assert len(m.reception_rows) == s["canonical"] + s["duplicate"]
