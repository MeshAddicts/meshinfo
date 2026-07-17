"""
Behavioral tests for the MQTT handlers — pin down the defensive guards that
prevent a malformed packet from crashing the handler and killing the MQTT
loop (which would drop other in-flight messages including corrective NODEINFOs).
"""

import asyncio


from broadcaster import Broadcaster
from mqtt import MQTT, normalize_node_id  # noqa: F401  (re-exported via from utils)


# Inline fakes: record interactions without touching the network or a real DB.


class FakePgStorage:
    def __init__(self, nodes=None):
        self._nodes: dict = dict(nodes or {})
        self.writes: list = []
        self.chat_writes: list = []
        self.telemetry_writes: list = []
        self.traceroute_writes: list = []
        self.mqtt_writes: list = []
        self._mqtt_row_seq = 0
        self.pool = None  # disables _write_node_telemetry_current side-branch

    async def write_mqtt_message(self, mqtt_msg) -> int:
        self.mqtt_writes.append(dict(mqtt_msg))
        self._mqtt_row_seq += 1
        return self._mqtt_row_seq

    async def get_node_cached(self, node_id: str):
        return self._nodes.get(node_id)

    def cache_node_set(self, node_id: str, node) -> None:
        self._nodes[node_id] = node

    async def write_node(self, node_id: str, node) -> None:
        # Copy on write so test assertions see a snapshot of the moment.
        self._nodes[node_id] = node
        self.writes.append((node_id, dict(node)))

    async def write_chat_message(self, from_id: str, chat) -> None:
        self.chat_writes.append((from_id, dict(chat)))

    async def write_telemetry(self, node_id: str, msg) -> None:
        self.telemetry_writes.append((node_id, dict(msg)))

    async def write_traceroute(self, node_id: str, msg) -> None:
        self.traceroute_writes.append((node_id, dict(msg)))

    async def find_node_by_longname(self, name: str):
        for nid, n in self._nodes.items():
            if n.get("longname", "").lower() == name.lower():
                return dict(n, id=nid)
        return None


class FakeDataStore:
    def __init__(self, config, nodes=None):
        self.config = config
        self.pg_storage = FakePgStorage(nodes=nodes)
        self.discord_event_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        # Real hub — it's dependency-free, so handlers exercise the actual
        # publish path and tests can drain a subscriber queue.
        self.broadcaster = Broadcaster()

    async def update_node(self, node_id: str, node) -> None:
        await self.pg_storage.write_node(node_id, node)
        self.pg_storage.cache_node_set(node_id, node)


def make_mqtt(nodes=None):
    """Build an MQTT instance wired up with fakes — no broker, no DB."""
    config = {
        "broker": {
            "host": "localhost",
            "port": 1883,
            "client_id": "test",
            "username": "",
            "password": "",
        },
        "server": {
            "timezone": "UTC",
        },
    }
    data = FakeDataStore(config, nodes=nodes)
    return MQTT(config, data), data


def run(coro):
    """Drive an async function without pytest-asyncio (not in requirements-dev)."""
    return asyncio.new_event_loop().run_until_complete(coro)


# ─────────────────────────────────────────────────────────────────────────────
# handle_nodeinfo — the headline "Unknown nodes" path
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleNodeinfo:
    def test_happy_path_writes_longname_and_shortname(self):
        mqtt, data = make_mqtt()
        msg = {
            "from": 0x67EA9400,
            "payload": {
                "id": "67ea9400",
                "long_name": "Central Valley Test",
                "short_name": "CVT",
                "hw_model": 9,
            },
        }
        run(mqtt.handle_nodeinfo(msg))
        node = data.pg_storage._nodes["67ea9400"]
        assert node["longname"] == "Central Valley Test"
        assert node["shortname"] == "CVT"
        assert node["hardware"] == 9
        assert node["role"] == 0  # default when not provided

    def test_falls_back_to_meshpacket_from_when_payload_id_missing(self):
        """NODEINFO with User.id unset must resolve via MeshPacket 'from',
        otherwise the node sticks at default 'Unknown' indefinitely."""
        mqtt, data = make_mqtt()
        msg = {
            "from": 0x67EA9400,
            "payload": {"long_name": "No-Id Node", "short_name": "NIN"},
        }
        run(mqtt.handle_nodeinfo(msg))
        assert "67ea9400" in data.pg_storage._nodes
        assert data.pg_storage._nodes["67ea9400"]["longname"] == "No-Id Node"

    def test_skips_when_both_payload_id_and_from_missing(self):
        mqtt, data = make_mqtt()
        msg = {"payload": {"long_name": "Orphan"}}
        # Must not crash; just no-op.
        run(mqtt.handle_nodeinfo(msg))
        assert data.pg_storage._nodes == {}
        assert data.pg_storage.writes == []

    def test_skips_when_payload_missing(self):
        mqtt, data = make_mqtt()
        msg = {"from": 0x67EA9400}
        run(mqtt.handle_nodeinfo(msg))
        assert data.pg_storage._nodes == {}

    def test_normalizes_int_payload_id(self):
        """JSON publishers may send id as int or str — both must map to the same node."""
        mqtt, data = make_mqtt()
        run(mqtt.handle_nodeinfo({"from": 0x67EA9400, "payload": {"id": 0x67EA9400, "long_name": "X"}}))
        run(mqtt.handle_nodeinfo({"from": 0x67EA9400, "payload": {"id": "67ea9400", "long_name": "Y"}}))
        # Two updates against the same canonical id, not two different node rows.
        assert len(data.pg_storage._nodes) == 1
        assert data.pg_storage._nodes["67ea9400"]["longname"] == "Y"

    def test_accepts_both_long_name_and_longname_keys(self):
        """Protobuf path emits long_name; JSON path sometimes emits longname."""
        mqtt, data1 = make_mqtt()
        run(mqtt.handle_nodeinfo({"from": 0x1, "payload": {"long_name": "Snake"}}))
        assert data1.pg_storage._nodes["00000001"]["longname"] == "Snake"

        mqtt, data2 = make_mqtt()
        run(mqtt.handle_nodeinfo({"from": 0x1, "payload": {"longname": "Compact"}}))
        assert data2.pg_storage._nodes["00000001"]["longname"] == "Compact"


# ─────────────────────────────────────────────────────────────────────────────
# handle_mapreport — NODEINFO-like enrichment from MAP_REPORT_APP packets
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleMapreport:
    def _ok_msg(self, **payload_overrides):
        payload = {
            "long_name": "Ridge Repeater",
            "short_name": "RDG",
            "hw_model": 31,
            "role": 2,
            "firmware_version": "2.5.3",
            "latitude_i": 371234567,
            "longitude_i": -1219876543,
            "altitude": 812,
            "position_precision": 16,
        }
        payload.update(payload_overrides)
        # sender is the ServiceEnvelope gateway_id — always a "!hex" string.
        return {"from": 0x11223344, "sender": "!aabbccdd", "channel": 0, "payload": payload}

    def test_happy_path_enriches_node_and_fills_position(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_mapreport(self._ok_msg()))
        node = data.pg_storage._nodes["11223344"]
        assert node["longname"] == "Ridge Repeater"
        assert node["shortname"] == "RDG"
        assert node["hardware"] == 31
        assert node["role"] == 2
        assert node["position"]["latitude_i"] == 371234567
        assert node["position"]["longitude_i"] == -1219876543
        assert node["position"]["altitude"] == 812
        # MapReport calls it position_precision; node_positions stores precision_bits.
        assert node["position"]["precision_bits"] == 16
        assert node["gateway"] == "aabbccdd"
        assert node["last_channel"] == "0"

    def test_role_defaults_to_client_when_omitted(self):
        """proto3 omits zero enums, so an absent role IS role CLIENT (0)."""
        mqtt, data = make_mqtt()
        msg = self._ok_msg()
        del msg["payload"]["role"]
        run(mqtt.handle_mapreport(msg))
        assert data.pg_storage._nodes["11223344"]["role"] == 0

    def test_does_not_overwrite_existing_position(self):
        """Map reports are timeless; a position learned from a real POSITION
        packet must win over them, cache included."""
        existing = {"latitude_i": 1, "longitude_i": 2, "time": 1234}
        seed = {"id": "11223344", "longname": "X", "shortname": "Y",
                "position": dict(existing)}
        mqtt, data = make_mqtt(nodes={"11223344": seed})
        run(mqtt.handle_mapreport(self._ok_msg()))
        assert data.pg_storage._nodes["11223344"]["position"] == existing

    def test_absent_coords_leave_position_unset(self):
        mqtt, data = make_mqtt()
        msg = self._ok_msg()
        for key in ("latitude_i", "longitude_i", "altitude", "position_precision"):
            del msg["payload"][key]
        run(mqtt.handle_mapreport(msg))
        assert data.pg_storage._nodes["11223344"]["position"] is None

    def test_missing_payload_skips_without_write(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_mapreport({"from": 0x11223344}))
        assert data.pg_storage.writes == []

    def test_missing_from_skips_without_write(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_mapreport({"payload": {"long_name": "Ghost"}}))
        assert data.pg_storage.writes == []


# ─────────────────────────────────────────────────────────────────────────────
# handle_text — chat path with required-field guards
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleText:
    def _ok_msg(self, **overrides):
        base = {
            "id": 1234,
            "from": 0x67EA9400,
            "to": 0xFFFFFFFF,
            "timestamp": 1700000000,
            "payload": {"text": "hello mesh"},
        }
        base.update(overrides)
        return base

    def test_happy_path_writes_chat_message(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_text(self._ok_msg()))
        assert len(data.pg_storage.chat_writes) == 1
        from_id, chat = data.pg_storage.chat_writes[0]
        assert from_id == "67ea9400"
        assert chat["text"] == "hello mesh"
        assert chat["to"] == "ffffffff"

    def test_publishes_chat_sse_event(self):
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        run(mqtt.handle_text(self._ok_msg()))
        event_type, payload = q.get_nowait()
        assert event_type == "chat"
        assert payload["text"] == "hello mesh"
        assert payload["id"] == 1234
        assert payload["from"] == "67ea9400"
        assert payload["channel"] == "0"  # defaulted when absent

    def test_no_sse_event_when_text_invalid(self):
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        run(mqtt.handle_text(self._ok_msg(payload={})))
        assert q.empty()

    def test_skips_when_from_missing(self):
        mqtt, data = make_mqtt()
        m = self._ok_msg()
        del m["from"]
        run(mqtt.handle_text(m))
        assert data.pg_storage.chat_writes == []

    def test_skips_when_payload_text_missing(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_text(self._ok_msg(payload={})))
        assert data.pg_storage.chat_writes == []

    def test_skips_when_payload_not_dict(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_text(self._ok_msg(payload="not-a-dict")))
        assert data.pg_storage.chat_writes == []

    def test_skips_when_id_missing(self):
        mqtt, data = make_mqtt()
        m = self._ok_msg()
        del m["id"]
        run(mqtt.handle_text(m))
        assert data.pg_storage.chat_writes == []

    def test_skips_when_timestamp_missing(self):
        mqtt, data = make_mqtt()
        m = self._ok_msg()
        del m["timestamp"]
        run(mqtt.handle_text(m))
        assert data.pg_storage.chat_writes == []

    def test_handles_missing_to(self):
        """`to` is optional (broadcast/direct distinction); missing must not crash."""
        mqtt, data = make_mqtt()
        m = self._ok_msg()
        del m["to"]
        run(mqtt.handle_text(m))
        assert len(data.pg_storage.chat_writes) == 1
        assert data.pg_storage.chat_writes[0][1]["to"] is None


# ─────────────────────────────────────────────────────────────────────────────
# handle_log — raw packet archive write + live packet SSE event
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleLog:
    def _msg(self, **overrides):
        base = {
            "topic": "msh/US/2/e/LongFast/!67ea9400",
            "from": 0x67EA9400,
            "type": "position",
            "id": 99,
            "timestamp": 1700000000,
            "payload": {"latitude_i": 1},
            "decoded": {"raw": "x"},
            "encrypted": "deadbeef",
        }
        base.update(overrides)
        return base

    def test_writes_archive_without_decoded_encrypted(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_log(self._msg()))
        assert len(data.pg_storage.mqtt_writes) == 1
        stored = data.pg_storage.mqtt_writes[0]
        assert "decoded" not in stored and "encrypted" not in stored
        assert stored["topic"].endswith("!67ea9400")

    def test_publishes_packet_event_with_row_id(self):
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        run(mqtt.handle_log(self._msg()))
        event_type, payload = q.get_nowait()
        assert event_type == "packet"
        assert payload["mqtt_row_id"] == 1  # FakePgStorage returns a 1-based seq
        assert payload["type"] == "position"
        # The live payload mirrors the stored shape (no decoded/encrypted).
        assert "decoded" not in payload and "encrypted" not in payload

    def test_no_packet_event_when_write_fails(self):
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        # Simulate storage unavailable: write returns None -> no row id -> no emit.
        async def _no_id(_msg):
            return None
        data.pg_storage.write_mqtt_message = _no_id
        run(mqtt.handle_log(self._msg()))
        assert q.empty()


# ─────────────────────────────────────────────────────────────────────────────
# handle_telemetry — merges payload into the node + emits a live telemetry event
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleTelemetry:
    def _msg(self, **overrides):
        base = {
            "from": 0x67EA9400,
            "id": 555,
            "channel": 0,
            "timestamp": 1700000000,
            "telemetry_type": "device_metrics",
            "payload": {"battery_level": 90, "voltage": 4.1},
            "rssi": -100,
            "snr": 5.0,
        }
        base.update(overrides)
        return base

    def test_merges_payload_into_node_telemetry(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_telemetry(self._msg()))
        node = data.pg_storage._nodes["67ea9400"]
        assert node["telemetry"]["battery_level"] == 90
        assert len(data.pg_storage.telemetry_writes) == 1

    def test_publishes_telemetry_event(self):
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        run(mqtt.handle_telemetry(self._msg()))
        event_type, payload = q.get_nowait()
        assert event_type == "telemetry"
        assert payload["from"] == "67ea9400"
        assert payload["telemetry_type"] == "device_metrics"
        assert payload["payload"]["battery_level"] == 90

    def test_no_telemetry_event_without_payload(self):
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        m = self._msg()
        del m["payload"]
        run(mqtt.handle_telemetry(m))
        assert q.empty()


# ─────────────────────────────────────────────────────────────────────────────
# handle_traceroute — route normalization handles both int + str entries
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleTraceroute:
    def test_protobuf_int_route_normalized_to_hex(self):
        mqtt, data = make_mqtt(nodes={
            "67ea9400": {"id": "67ea9400", "longname": "A"},
            "abcd1234": {"id": "abcd1234", "longname": "B"},
        })
        msg = {
            "from": 0x67EA9400,
            "payload": {"route": [0x67EA9400, 0xABCD1234]},
        }
        run(mqtt.handle_traceroute(msg))
        assert len(data.pg_storage.traceroute_writes) == 1
        _, written = data.pg_storage.traceroute_writes[0]
        assert written["route_ids"] == ["67ea9400", "abcd1234"]

    def test_publishes_traceroute_event(self):
        mqtt, data = make_mqtt(nodes={
            "67ea9400": {"id": "67ea9400", "longname": "A"},
            "abcd1234": {"id": "abcd1234", "longname": "B"},
        })
        q = data.broadcaster.subscribe()
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "to": 0xABCD1234,
            "payload": {"route": [0x67EA9400]},
        }))
        event_type, payload = q.get_nowait()
        assert event_type == "traceroute"
        assert payload["from"] == "67ea9400"
        assert payload["to"] == "abcd1234"
        assert payload["route_ids"] == ["67ea9400"]

    def test_json_longname_route_resolved(self):
        mqtt, data = make_mqtt(nodes={
            "67ea9400": {"id": "67ea9400", "longname": "Alpha"},
        })
        msg = {
            "from": "67ea9400",
            "payload": {"route": ["Alpha", "Unknown Longname"]},
        }
        run(mqtt.handle_traceroute(msg))
        _, written = data.pg_storage.traceroute_writes[0]
        # Resolved longname → id; unresolved string → echo back.
        assert written["route_ids"] == ["67ea9400", "Unknown Longname"]

    def test_skips_when_payload_route_missing(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_traceroute({"from": 0x1, "payload": {}}))
        assert data.pg_storage.traceroute_writes == []

    def test_skips_when_from_missing(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_traceroute({"payload": {"route": [1, 2]}}))
        assert data.pg_storage.traceroute_writes == []


# ─────────────────────────────────────────────────────────────────────────────
# _safe_handle — pipeline-survival guard
# ─────────────────────────────────────────────────────────────────────────────


class TestSafeHandle:
    def test_swallows_handler_exception(self):
        """A handler crash must not bubble up — otherwise one bad packet kills the loop."""
        mqtt, _ = make_mqtt()

        async def boom():
            raise RuntimeError("simulated handler crash")

        # Must NOT raise; logged + swallowed.
        run(mqtt._safe_handle("boom_handler", boom()))

    def test_does_not_swallow_results_on_success(self):
        mqtt, _ = make_mqtt()
        marker = {"ran": False}

        async def ok():
            marker["ran"] = True

        run(mqtt._safe_handle("ok_handler", ok()))
        assert marker["ran"] is True


# ─────────────────────────────────────────────────────────────────────────────
# _normalize_msg_addrs — defensive 'from' / 'to' / 'sender' normalization
# ─────────────────────────────────────────────────────────────────────────────


class TestNormalizeMsgAddrs:
    def test_int_from_converted_to_hex(self):
        mqtt, _ = make_mqtt()
        msg = {"from": 0x67EA9400, "to": 0xFFFFFFFF}
        result = mqtt._normalize_msg_addrs(msg)
        assert result == "67ea9400"
        assert msg["from"] == "67ea9400"
        assert msg["to"] == "ffffffff"

    def test_missing_from_returns_none(self):
        mqtt, _ = make_mqtt()
        assert mqtt._normalize_msg_addrs({}) is None

    def test_invalid_from_returns_none(self):
        mqtt, _ = make_mqtt()
        assert mqtt._normalize_msg_addrs({"from": "not-hex!"}) is None

    def test_malformed_to_dropped(self):
        mqtt, _ = make_mqtt()
        msg = {"from": 0x1, "to": "garbage!!!"}
        mqtt._normalize_msg_addrs(msg)
        assert "to" not in msg

    def test_sender_bang_stripped(self):
        mqtt, _ = make_mqtt()
        msg = {"from": 0x1, "sender": "!67ea9400"}
        mqtt._normalize_msg_addrs(msg)
        assert msg["sender"] == "67ea9400"
