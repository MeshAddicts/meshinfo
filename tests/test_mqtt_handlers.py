"""
Behavioral tests for the MQTT handlers — pin down the defensive guards that
prevent a malformed packet from crashing the handler and killing the MQTT
loop (which would drop other in-flight messages including corrective NODEINFOs).
"""

import json

from meshtastic import mesh_pb2, portnums_pb2

from mqtt import MQTT, normalize_node_id  # noqa: F401  (re-exported via from utils)

from _helpers import FakeDataStore, FakeMqttMessage, build_envelope, run


def make_mqtt(nodes=None, json_decoder=False, protobuf_decoder=True):
    """Build an MQTT instance wired up with fakes — no broker, no DB."""
    config = {
        "broker": {
            "host": "localhost",
            "port": 1883,
            "client_id": "test",
            "username": "",
            "password": "",
            # channels.encryption is only read in the encrypted branch,
            # which these tests never enter — deliberately absent.
            "decoders": {
                "protobuf": {"enabled": protobuf_decoder},
                "json": {"enabled": json_decoder},
            },
        },
        "server": {
            "timezone": "UTC",
        },
    }
    data = FakeDataStore(config, nodes=nodes)
    return MQTT(config, data), data


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

    def test_event_carries_full_traceroute_row(self):
        """The SSE event mirrors a non-slim /v1/traceroutes row (same names,
        same value types — timestamp stays epoch seconds like the BIGINT
        column) so the SPA can upsert it into its cached list instead of
        refetching the endpoint."""
        mqtt, data = make_mqtt(nodes={
            "67ea9400": {"id": "67ea9400", "longname": "A"},
            "abcd1234": {"id": "abcd1234", "longname": "B"},
        })
        q = data.broadcaster.subscribe()
        payload = {
            "route": [0x67EA9400],
            "route_back": [],
            "snr_towards": [-13],
            "snr_back": [],
        }
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "to": 0xABCD1234,
            "sender": "!ABCD1234",
            "id": 987654321,
            "channel": 3,
            "hops_away": 2,
            "rssi": -110,
            "snr": -13.5,
            "timestamp": 1753500000,
            "payload": payload,
        }))
        _, event = q.get_nowait()
        # created_at is the handler's now() approximation of the DB default
        created_at = event.pop("created_at")
        assert isinstance(created_at, int) and created_at > 1753500000
        assert event == {
            "from": "67ea9400",
            "to": "abcd1234",
            # Normalized like the DB write, not the raw gateway string.
            "sender": "abcd1234",
            "id": 987654321,
            "channel": 3,
            "packet_id": None,
            "hops_away": 2,
            "rssi": -110,
            "snr": -13.5,
            "timestamp": 1753500000,
            "route": [0x67EA9400],
            "route_ids": ["67ea9400"],
            "route_back_ids": [],
            "payload": payload,
        }

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

    def test_unknown_int_hop_stored_as_canonical_hex(self):
        """Raw ints never re-resolve and fragment route grouping."""
        mqtt, data = make_mqtt(nodes={
            "67ea9400": {"id": "67ea9400", "longname": "A"},
        })
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "payload": {"route": [0x67EA9400, 0xDEADBEEF, 0x0165EC15]},
        }))
        _, written = data.pg_storage.traceroute_writes[0]
        # Known node resolves; unknown ints become padded 8-hex
        assert written["route_ids"] == ["67ea9400", "deadbeef", "0165ec15"]

    def test_out_of_uint32_int_hop_kept_raw(self):
        mqtt, data = make_mqtt()
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "payload": {"route": [2**40]},
        }))
        _, written = data.pg_storage.traceroute_writes[0]
        assert written["route_ids"] == [2**40]

    def test_route_back_resolved_like_forward_route(self):
        mqtt, data = make_mqtt(nodes={
            "67ea9400": {"id": "67ea9400", "longname": "A"},
        })
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "to": 0xABCD1234,
            "id": 900,
            "payload": {
                "route": [0x67EA9400],
                "snr_towards": [4, 8],
                "route_back": [0xDEADBEEF, 0x67EA9400],
                "snr_back": [3, 5],
            },
        }))
        _, written = data.pg_storage.traceroute_writes[0]
        # Known node resolves, unknown int becomes canonical hex
        assert written["route_back_ids"] == ["deadbeef", "67ea9400"]

    def test_bool_hop_not_minted_into_node_id(self):
        """bool subclasses int: `true` must echo verbatim, never become node 00000001."""
        mqtt, data = make_mqtt()
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "payload": {"route": [True]},
        }))
        _, written = data.pg_storage.traceroute_writes[0]
        assert written["route_ids"] == [True]

    def test_sse_event_carries_hex_fallback(self):
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "to": 0xABCD1234,
            "payload": {"route": [0xDEADBEEF]},
        }))
        _, event = q.get_nowait()
        assert event["route_ids"] == ["deadbeef"]

    def test_duplicate_copy_broadcasts_no_second_event(self):
        """A poorer/equal gateway copy stays silent — live feed mirrors storage."""
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        msg = {
            "from": 0x67EA9400,
            "to": 0xABCD1234,
            "id": 555,
            "payload": {"route": [1], "snr_towards": [4]},
        }
        run(mqtt.handle_traceroute(dict(msg)))
        run(mqtt.handle_traceroute(dict(msg)))  # identical second copy
        assert q.qsize() == 1
        assert len(data.pg_storage.traceroute_writes) == 1

    def test_richer_copy_broadcasts_upgraded_event(self):
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "to": 0xABCD1234,
            "id": 556,
            "payload": {"route": [1, 2], "snr_towards": [4, 8, 12], "route_back": []},
        }))
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "to": 0xABCD1234,
            "id": 556,
            "payload": {
                "route": [1, 2],
                "snr_towards": [4, 8, 12],
                "route_back": [3, 4],
                "snr_back": [9, 10],
            },
        }))
        assert q.qsize() == 2
        q.get_nowait()
        _, upgraded = q.get_nowait()
        assert upgraded["payload"]["route_back"] == [3, 4]
        _, written = data.pg_storage.traceroute_writes[0]
        assert written["payload"]["route_back"] == [3, 4]

    def test_outage_none_outcome_still_broadcasts(self):
        """DB down (outcome None): the live feed must not go dark."""
        mqtt, data = make_mqtt()

        async def down(node_id, msg):
            return None

        data.pg_storage.write_traceroute = down
        q = data.broadcaster.subscribe()
        run(mqtt.handle_traceroute({
            "from": 0x67EA9400,
            "to": 0xABCD1234,
            "id": 557,
            "payload": {"route": [1]},
        }))
        assert q.qsize() == 1


# ─────────────────────────────────────────────────────────────────────────────
# process_mqtt_msg — envelope decode; pins the proto3 zero-omission fixes
# ─────────────────────────────────────────────────────────────────────────────


class TestProcessEnvelope:
    def _archived(self, msg, nodes=None):
        mqtt, data = make_mqtt(nodes=nodes)
        run(mqtt.process_mqtt_msg(None, msg))
        assert len(data.pg_storage.mqtt_writes) == 1
        return data.pg_storage.mqtt_writes[0], data

    def test_exhausted_hops_get_real_hops_away(self):
        """hop_limit==0 (all hops used) vanishes from MessageToJson; hops_away must still compute."""
        archived, _ = self._archived(build_envelope(hop_start=3, hop_limit=0))
        assert archived["hops_away"] == 3
        assert archived["hop_start"] == 3
        assert archived["hop_limit"] == 0

    def test_pre23_firmware_leaves_hops_away_unknown(self):
        # hop_start==0: firmware that never reports it — unknown, not 0
        archived, _ = self._archived(build_envelope(hop_start=0, hop_limit=3))
        assert "hops_away" not in archived

    def test_hops_away_clamped_at_zero(self):
        # hop_limit > hop_start is a firmware anomaly; store 0, not negative
        archived, _ = self._archived(build_envelope(hop_start=2, hop_limit=5))
        assert archived["hops_away"] == 0

    def test_self_gateway_zero_pair_omits_rssi_and_snr(self):
        archived, _ = self._archived(build_envelope(rx_rssi=0, rx_snr=0.0))
        assert "rssi" not in archived
        assert "snr" not in archived

    def test_real_reception_kept_verbatim(self):
        archived, _ = self._archived(build_envelope(rx_rssi=-95, rx_snr=-7.25))
        assert archived["rssi"] == -95
        assert archived["snr"] == -7.25

    def test_snr_only_legacy_gateway_keeps_snr(self):
        archived, _ = self._archived(build_envelope(rx_rssi=0, rx_snr=5.5))
        assert "rssi" not in archived
        assert archived["snr"] == 5.5

    def test_primary_channel_zero_archived(self):
        archived, _ = self._archived(build_envelope(channel=0))
        assert archived["channel"] == 0

    def test_nonzero_channel_unchanged(self):
        archived, _ = self._archived(build_envelope(channel=2))
        assert archived["channel"] == 2

    def test_zero_hop_traceroute_not_dropped(self):
        """Empty route (direct neighbor) still reaches write_traceroute;
        the decode yields route=[], not absent."""
        rd = mesh_pb2.RouteDiscovery(route=[], snr_towards=[-128])
        msg = build_envelope(
            portnum=portnums_pb2.TRACEROUTE_APP,
            payload=rd.SerializeToString(),
        )
        mqtt, data = make_mqtt()
        run(mqtt.process_mqtt_msg(None, msg))
        assert len(data.pg_storage.traceroute_writes) == 1
        _, written = data.pg_storage.traceroute_writes[0]
        assert written["payload"]["route"] == []
        assert written["payload"]["snr_towards"] == [-128]

    def test_traceroute_reply_request_id_captured_as_packet_id(self):
        rd = mesh_pb2.RouteDiscovery(route=[], snr_towards=[8])
        msg = build_envelope(
            portnum=portnums_pb2.TRACEROUTE_APP,
            payload=rd.SerializeToString(),
            request_id=424242,
        )
        mqtt, data = make_mqtt()
        run(mqtt.process_mqtt_msg(None, msg))
        _, written = data.pg_storage.traceroute_writes[0]
        assert written["packet_id"] == 424242

    def test_traceroute_request_has_null_packet_id(self):
        rd = mesh_pb2.RouteDiscovery(route=[], snr_towards=[])
        msg = build_envelope(
            portnum=portnums_pb2.TRACEROUTE_APP,
            payload=rd.SerializeToString(),
            request_id=0,  # proto3 unset — a request packet
        )
        mqtt, data = make_mqtt()
        run(mqtt.process_mqtt_msg(None, msg))
        _, written = data.pg_storage.traceroute_writes[0]
        assert written["packet_id"] is None

    def test_json_decoder_processes_when_protobuf_disabled(self):
        mqtt, data = make_mqtt(json_decoder=True, protobuf_decoder=False)
        payload = json.dumps({"type": "text", "from": 123}).encode("utf-8")
        msg = FakeMqttMessage("msh/US/2/json/LongFast/!abcd1234", payload)
        run(mqtt.process_mqtt_msg(None, msg))
        assert len(data.pg_storage.mqtt_writes) == 1
        assert data.pg_storage.mqtt_writes[0]["topic"] == "msh/US/2/json/LongFast/!abcd1234"

    def test_json_decoder_exclusive_with_protobuf(self):
        """Both enabled: /2/json copies are skipped — gateways publish the
        same packet to both namespaces."""
        mqtt, data = make_mqtt(json_decoder=True, protobuf_decoder=True)
        payload = json.dumps({"type": "text", "from": 123}).encode("utf-8")
        msg = FakeMqttMessage("msh/US/2/json/LongFast/!abcd1234", payload)
        run(mqtt.process_mqtt_msg(None, msg))
        assert data.pg_storage.mqtt_writes == []

    def test_packet_sse_event_omits_unmeasured_keys(self):
        """A zero rssi/snr pair arrives absent (not null) on the live 'packet' event."""
        mqtt, data = make_mqtt()
        q = data.broadcaster.subscribe()
        run(mqtt.process_mqtt_msg(
            None, build_envelope(rx_rssi=0, rx_snr=0.0, hop_start=3, hop_limit=0)
        ))
        # A text envelope also emits a 'chat' event; find the 'packet' one.
        events = {}
        while not q.empty():
            event_type, event = q.get_nowait()
            events[event_type] = event
        packet = events["packet"]
        assert "rssi" not in packet
        assert "snr" not in packet
        assert packet["hops_away"] == 3


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
