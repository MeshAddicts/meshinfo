"""
End-to-end tests for the encrypted-packet path of MQTT.process_mqtt_msg.

The AES-CTR decrypt block (mqtt.py, inside process_mqtt_msg) previously had no
test coverage: CI imported mqtt.py but never executed a decryption, so a
breaking change in the `cryptography` package — or a regression in the nonce
construction here — could ship while CI stayed green (the cryptography v50
bump merged blind this way).

These tests drive real serialized ServiceEnvelopes through process_mqtt_msg.
The headline tests use GOLDEN ciphertexts generated once and hard-coded, so
they cannot co-drift with the library under test: if AES-CTR semantics, the
Cipher API, or the nonce layout (packet_id LE64 ‖ from LE64) change, the
golden packets stop decrypting and the tests fail.

TestProcessPipelineBranches covers the adjacent non-crypto branches of the
same pipeline: malformed envelopes, packets that arrive already decoded,
binary text payloads, the future-rx_time clamp, and the sender fallbacks.
"""

import base64
import time

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from meshtastic import mesh_pb2, mqtt_pb2, portnums_pb2

from mqtt import MQTT

from _helpers import FakeDataStore, run


# Meshtastic default LongFast PSK (AES-128) — the key the golden vector uses.
DEFAULT_KEY_B64 = "1PG7OiApB1nwvP+rz05pAQ=="
# All-zero AES-128 key; verified to yield a protobuf DecodeError against the
# golden ciphertext (deterministic, so the wrong-key test cannot flake).
WRONG_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAA=="

# ServiceEnvelope{ packet: MeshPacket{ from=0x67EA9401, id=424242, channel=8,
# rx_time=1700000000, rx_rssi=-92, rx_snr=5.5, hop_start=3, hop_limit=1,
# encrypted=AES128-CTR(Data{TEXT_MESSAGE_APP, b"golden: mesh decrypt ok"}) },
# channel_id="LongFast", gateway_id="!67ea9400" }
# _build_encrypted_envelope(base64.b64decode(DEFAULT_KEY_B64), GOLDEN_TEXT)
# reproduces these bytes exactly (asserted by a test below), so the fixture
# can be regenerated with it if the packet shape ever needs to change.
GOLDEN_ENVELOPE_B64 = (
    "CkcNAZTqZxX/////GAgqGxaXolZakN1sN6pHsgzBsjcSGP44eKaDSEnCJzUyeQYAPQDxU2VF"
    "AACwQEgBYKT//////////wF4AxIITG9uZ0Zhc3QaCSE2N2VhOTQwMA=="
)
GOLDEN_TEXT = "golden: mesh decrypt ok"
GOLDEN_FROM_HEX = "67ea9401"
# Suffix deliberately differs from the envelope's gateway_id ("!67ea9400") so
# sender assertions can tell the gateway_id path from the topic fallback.
GOLDEN_TOPIC = "msh/US/2/e/LongFast/!deadbeef"

# Same packet shape encrypted with a 256-bit key (bytes(range(32))) — pinned
# like the AES-128 vector so the AES-256 path has co-drift protection too.
# Regenerate: _build_encrypted_envelope(base64.b64decode(AES256_KEY_B64), AES256_TEXT)
AES256_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
AES256_ENVELOPE_B64 = (
    "CkoNAZTqZxX/////GAgqHtHR6x5vtP3St8J6AzmvVFni22M5UMVZ0WXSrLBqKTUyeQYAPQDx"
    "U2VFAACwQEgBYKT//////////wF4AxIITG9uZ0Zhc3QaCSE2N2VhOTQwMA=="
)
AES256_TEXT = "golden256: mesh decrypt ok"


class FakeTopic:
    def __init__(self, value):
        self.value = value


class FakeMsg:
    """Shape-compatible stand-in for an aiomqtt message."""

    def __init__(self, topic, payload):
        self.topic = FakeTopic(topic)
        self.payload = payload
        self.qos = 0
        self.retain = False


def make_mqtt_pb(keys):
    """MQTT instance with the protobuf decoder enabled and the given
    channel-encryption key list (base64 strings), wired to fakes."""
    config = {
        "broker": {
            "host": "localhost",
            "port": 1883,
            "client_id": "test",
            "username": "",
            "password": "",
            "decoders": {
                "protobuf": {"enabled": True},
                "json": {"enabled": False},
            },
            "channels": {
                "encryption": [
                    {"key": k, "key_name": f"key{i}"} for i, k in enumerate(keys)
                ],
            },
        },
        "server": {
            "timezone": "UTC",
        },
    }
    data = FakeDataStore(config)
    return MQTT(config, data), data


def _build_encrypted_envelope(
    key_bytes,
    text,
    from_=0x67EA9401,
    pkt_id=424242,
    rx_rssi=-92,
    rx_snr=5.5,
    hop_start=3,
    hop_limit=1,
):
    """Serialize a ServiceEnvelope whose MeshPacket carries an AES-CTR
    encrypted TEXT_MESSAGE_APP payload, mirroring what a Meshtastic gateway
    uplinks. Nonce layout must match mqtt.py: packet_id LE64 ‖ from LE64.
    With default args and the default key this reproduces GOLDEN_ENVELOPE_B64
    byte-for-byte — pinned by test_regeneration_recipe_matches_golden."""
    data = mesh_pb2.Data()
    data.portnum = portnums_pb2.TEXT_MESSAGE_APP
    data.payload = text.encode("utf-8")

    nonce = pkt_id.to_bytes(8, "little") + from_.to_bytes(8, "little")
    encryptor = Cipher(algorithms.AES(key_bytes), modes.CTR(nonce)).encryptor()
    ciphertext = encryptor.update(data.SerializeToString()) + encryptor.finalize()

    mp = mesh_pb2.MeshPacket()
    setattr(mp, "from", from_)
    mp.to = 0xFFFFFFFF
    mp.id = pkt_id
    mp.channel = 8
    mp.rx_time = 1700000000
    mp.rx_rssi = rx_rssi
    mp.rx_snr = rx_snr
    mp.hop_start = hop_start
    mp.hop_limit = hop_limit
    mp.encrypted = ciphertext

    se = mqtt_pb2.ServiceEnvelope()
    se.packet.CopyFrom(mp)
    se.channel_id = "LongFast"
    se.gateway_id = "!67ea9400"
    return se.SerializeToString()


def _build_decoded_envelope(
    payload_bytes,
    portnum=portnums_pb2.TEXT_MESSAGE_APP,
    from_=0x67EA9401,
    pkt_id=424242,
    rx_time=1700000000,
    gateway_id="!67ea9400",
):
    """Serialize a ServiceEnvelope whose MeshPacket arrived already decoded
    (plaintext Data, no encryption) — the non-crypto side of the pipeline."""
    data = mesh_pb2.Data()
    data.portnum = portnum
    data.payload = payload_bytes

    mp = mesh_pb2.MeshPacket()
    setattr(mp, "from", from_)
    mp.to = 0xFFFFFFFF
    mp.id = pkt_id
    mp.channel = 8
    mp.rx_time = rx_time
    mp.decoded.CopyFrom(data)

    se = mqtt_pb2.ServiceEnvelope()
    se.packet.CopyFrom(mp)
    se.channel_id = "LongFast"
    se.gateway_id = gateway_id
    return se.SerializeToString()


class TestProcessEncryptedPacket:
    def test_golden_vector_decrypts_and_routes_text(self):
        """The pinned wire bytes must decrypt with the default LongFast key
        and come out the far end as a routed chat message."""
        mqtt, data = make_mqtt_pb([DEFAULT_KEY_B64])
        msg = FakeMsg(GOLDEN_TOPIC, base64.b64decode(GOLDEN_ENVELOPE_B64))

        run(mqtt.process_mqtt_msg(None, msg))

        assert len(data.pg_storage.mqtt_writes) == 1
        stored = data.pg_storage.mqtt_writes[0]
        assert stored["type"] == "text"
        assert stored["payload"] == {"text": GOLDEN_TEXT}
        # gateway_id path specifically — the topic suffix (!deadbeef) differs.
        assert stored["sender"] == "67ea9400"
        assert stored["timestamp"] == 1700000000
        assert stored["rssi"] == -92 and stored["snr"] == 5.5
        assert stored["hops_away"] == 2  # hop_start 3 - hop_limit 1
        # handle_log must strip the raw fields from the archive row.
        assert "decoded" not in stored and "encrypted" not in stored

        assert len(data.pg_storage.chat_writes) == 1
        from_id, chat = data.pg_storage.chat_writes[0]
        assert from_id == GOLDEN_FROM_HEX
        assert chat["text"] == GOLDEN_TEXT
        assert chat["channel"] == "8"

    def test_encrypted_packet_zero_header_fields_handled(self):
        """Zero-valued header fields must survive the decrypt branch's dict
        re-serialization: hops_away is read off mp directly (hop_limit==0 —
        an exhausted-hops packet — vanishes from MessageToJson output), and a
        zero rssi/snr pair stays absent instead of fabricating a reading."""
        mqtt, data = make_mqtt_pb([DEFAULT_KEY_B64])
        env = _build_encrypted_envelope(
            base64.b64decode(DEFAULT_KEY_B64),
            "zero header fields",
            rx_rssi=0,
            rx_snr=0.0,
            hop_start=3,
            hop_limit=0,
        )
        run(mqtt.process_mqtt_msg(None, FakeMsg(GOLDEN_TOPIC, env)))

        stored = data.pg_storage.mqtt_writes[0]
        assert stored["hops_away"] == 3
        assert stored["hop_limit"] == 0
        assert "rssi" not in stored
        assert "snr" not in stored

    def test_second_key_in_list_decrypts(self):
        """The key loop must survive a failing key and go on to the right one."""
        mqtt, data = make_mqtt_pb([WRONG_KEY_B64, DEFAULT_KEY_B64])
        msg = FakeMsg(GOLDEN_TOPIC, base64.b64decode(GOLDEN_ENVELOPE_B64))

        run(mqtt.process_mqtt_msg(None, msg))

        assert data.pg_storage.mqtt_writes[0]["type"] == "text"
        assert data.pg_storage.chat_writes[0][1]["text"] == GOLDEN_TEXT

    def test_wrong_key_archives_unknown_without_crash(self):
        """An undecryptable packet must not kill the loop: it is archived as
        type 'unknown' with the ciphertext stripped, and no chat is routed."""
        mqtt, data = make_mqtt_pb([WRONG_KEY_B64])
        msg = FakeMsg(GOLDEN_TOPIC, base64.b64decode(GOLDEN_ENVELOPE_B64))

        run(mqtt.process_mqtt_msg(None, msg))

        assert len(data.pg_storage.mqtt_writes) == 1
        stored = data.pg_storage.mqtt_writes[0]
        assert stored["type"] == "unknown"
        assert "encrypted" not in stored and "decoded" not in stored
        assert data.pg_storage.chat_writes == []

    def test_aes256_key_decrypts(self):
        """256-bit channel keys go through the same code path as 128-bit.
        Uses a pinned ciphertext (no test-time encryption) so a symmetric
        encrypt+decrypt regression can't co-drift into a false pass."""
        mqtt, data = make_mqtt_pb([AES256_KEY_B64])
        msg = FakeMsg(GOLDEN_TOPIC, base64.b64decode(AES256_ENVELOPE_B64))

        run(mqtt.process_mqtt_msg(None, msg))

        assert data.pg_storage.mqtt_writes[0]["type"] == "text"
        assert data.pg_storage.chat_writes[0][1]["text"] == AES256_TEXT

    def test_regeneration_recipe_matches_golden(self):
        """The helper must reproduce the pinned fixtures byte-for-byte: keeps
        the regeneration recipe honest and pins the encrypt direction against
        keystream drift (the golden bytes never re-encrypt at test time)."""
        rebuilt = _build_encrypted_envelope(
            base64.b64decode(DEFAULT_KEY_B64), GOLDEN_TEXT
        )
        assert rebuilt == base64.b64decode(GOLDEN_ENVELOPE_B64)
        rebuilt256 = _build_encrypted_envelope(
            base64.b64decode(AES256_KEY_B64), AES256_TEXT
        )
        assert rebuilt256 == base64.b64decode(AES256_ENVELOPE_B64)


class TestProcessPipelineBranches:
    def test_malformed_envelope_is_discarded(self):
        """Garbage that fails ServiceEnvelope parsing is dropped before any
        archive write — and must not raise out of the pipeline."""
        mqtt, data = make_mqtt_pb([DEFAULT_KEY_B64])

        run(mqtt.process_mqtt_msg(None, FakeMsg(GOLDEN_TOPIC, b"\xff" * 16)))

        assert data.pg_storage.mqtt_writes == []
        assert data.pg_storage.chat_writes == []

    def test_already_decoded_packet_needs_no_keys(self):
        """Plaintext uplinks must route with no encryption keys configured."""
        mqtt, data = make_mqtt_pb([])
        payload = _build_decoded_envelope(b"plaintext uplink")

        run(mqtt.process_mqtt_msg(None, FakeMsg(GOLDEN_TOPIC, payload)))

        stored = data.pg_storage.mqtt_writes[0]
        assert stored["type"] == "text"
        assert stored["payload"] == {"text": "plaintext uplink"}
        assert data.pg_storage.chat_writes[0][1]["text"] == "plaintext uplink"

    def test_already_decoded_packet_survives_configured_keys(self):
        """Configured keys must not touch a packet that arrived decoded. If
        the encrypted-only guard ever weakened, the key loop would 'decrypt'
        the unset (empty) ciphertext into an empty Data and clobber the real
        payload — this pins the plaintext surviving intact."""
        mqtt, data = make_mqtt_pb([DEFAULT_KEY_B64])
        payload = _build_decoded_envelope(b"plaintext with keys")

        run(mqtt.process_mqtt_msg(None, FakeMsg(GOLDEN_TOPIC, payload)))

        stored = data.pg_storage.mqtt_writes[0]
        assert stored["type"] == "text"
        assert stored["payload"] == {"text": "plaintext with keys"}

    def test_non_utf8_text_payload_archived_not_routed(self):
        """A TEXT packet with non-UTF8 bytes archives as text_binary
        (base64) and must not reach the chat handler."""
        raw = b"\x80\x81\xff\xfe"
        mqtt, data = make_mqtt_pb([])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(GOLDEN_TOPIC, _build_decoded_envelope(raw))
        ))

        stored = data.pg_storage.mqtt_writes[0]
        assert stored["type"] == "text_binary"
        assert stored["payload"] == {
            "text_b64": base64.b64encode(raw).decode("ascii"),
            "len": len(raw),
        }
        assert data.pg_storage.chat_writes == []

    def test_future_rx_time_clamped_to_now(self):
        """A node clock >5 min ahead must not poison the archive timestamp."""
        payload = _build_decoded_envelope(b"future clock", rx_time=4102444800)
        mqtt, data = make_mqtt_pb([])

        t0 = int(time.time())
        run(mqtt.process_mqtt_msg(None, FakeMsg(GOLDEN_TOPIC, payload)))
        t1 = int(time.time())

        assert t0 <= data.pg_storage.mqtt_writes[0]["timestamp"] <= t1

    def test_sender_falls_back_to_topic_suffix(self):
        """With no gateway_id in the envelope, sender comes from the topic's
        !suffix."""
        payload = _build_decoded_envelope(b"no gateway", gateway_id="")
        mqtt, data = make_mqtt_pb([])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg("msh/US/2/e/LongFast/!abcd1234", payload)
        ))

        assert data.pg_storage.mqtt_writes[0]["sender"] == "abcd1234"

    def test_overlong_gateway_id_ignored(self):
        """A gateway_id longer than 8 hex chars is distrusted; the topic
        suffix wins instead."""
        payload = _build_decoded_envelope(b"long gw", gateway_id="!deadbeefcafe")
        mqtt, data = make_mqtt_pb([])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg("msh/US/2/e/LongFast/!abcd1234", payload)
        ))

        assert data.pg_storage.mqtt_writes[0]["sender"] == "abcd1234"
