"""
Tests for channel-bucket resolution (channels.py + its use in process_mqtt_msg).

`MeshPacket.channel` is two namespaces in one field: an 8-bit (name, PSK) hash
on encrypted uplinks, and the gateway's local slot index (0-7) once a gateway
running with `mqtt.encryption_enabled = false` has decoded the packet. Storing
both verbatim scattered one logical channel across buckets, with the winning
bucket decided by whichever gateway's copy was ingested first.

Two tests exist specifically to kill mutants that an earlier version of this
file let through — see test_assignment_not_setdefault and
test_encrypted_is_not_treated_as_index. Both pin behaviour that is otherwise
invisible because most packets resolve to the value they came in with.
"""

import base64

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from meshtastic import mesh_pb2, mqtt_pb2, portnums_pb2

import channels

from _helpers import FakeMqttMessage as FakeMsg, run
from test_mqtt_decrypt import make_mqtt_pb

DEFAULT_PSK_B64 = "1PG7OiApB1nwvP+rz05pAQ=="
DEFAULT_PSK = base64.b64decode(DEFAULT_PSK_B64)


class TestHash:
    def test_reproduces_firmware_preset_hashes(self):
        """Pinned against the preset names Meshtastic firmware actually emits
        (DisplayFormatters.cpp), NOT against config.toml.sample — the sample is
        partly wrong and a test sourced from it would just re-derive its errors.
        Every name here has been corroborated by live archive traffic.
        """
        expected = {
            "ShortTurbo": 14,
            "ShortSlow": 119,
            "ShortFast": 112,
            "MediumSlow": 24,
            "MediumFast": 31,
            "LongSlow": 15,
            "LongFast": 8,
            "LongTurbo": 118,
            "LongMod": 110,
        }
        for name, want in expected.items():
            assert channels.channel_hash(name, DEFAULT_PSK) == want, name

    def test_sample_preset_names_that_firmware_never_emits(self):
        """Older sample configs shipped meta.9 "LongModerate" and meta.55
        "VeryLongSlow". The arithmetic is right but the names are not firmware
        preset strings, so those buckets can never populate — the sample now
        ships the real ones, LongMod (110) and LongTurbo (118). Pinned so the
        legacy hashes stay documented for operator configs that still carry
        the old spellings."""
        assert channels.channel_hash("LongModerate", DEFAULT_PSK) == 9
        assert channels.channel_hash("VeryLongSlow", DEFAULT_PSK) == 55
        assert channels.channel_hash("LongMod", DEFAULT_PSK) != 9
        assert channels.channel_hash("LongTurbo", DEFAULT_PSK) != 55

    def test_xor_hash_of_default_psk(self):
        assert channels.xor_hash(DEFAULT_PSK) == 2

    def test_empty_name_is_not_a_preset(self):
        """Firmware substitutes the preset string for a blank name, so the empty
        string is never hashed on real hardware — 2 is not 'unconfigured'."""
        assert channels.channel_hash("", DEFAULT_PSK) == 2

    def test_case_folding_is_parity_not_equality(self):
        # Each letter that changes case flips 0x20; an even count cancels.
        assert channels.channel_hash("longfast", DEFAULT_PSK) == 8  # L,F -> 2 flips
        assert channels.channel_hash("lOngFast", DEFAULT_PSK) == 8  # L,o -> 2 flips
        assert channels.channel_hash("LongFasT", DEFAULT_PSK) != 8  # t   -> 1 flip

    def test_distinct_psk_moves_the_whole_space(self):
        assert channels.channel_hash("LongFast", bytes(16)) != channels.channel_hash(
            "LongFast", DEFAULT_PSK
        )

    def test_non_ascii_name(self):
        assert 0 <= channels.channel_hash("Ünïcode", DEFAULT_PSK) <= 255


class TestNameFromTopic:
    def test_standard_encrypted_topic(self):
        assert channels.name_from_topic("msh/US/GA/2/e/LongFast/!aabbccdd") == "LongFast"

    def test_deep_region_prefix(self):
        assert (
            channels.name_from_topic("msh/US/CA/SacValley/2/e/MediumFast/!1234")
            == "MediumFast"
        )

    def test_non_encrypted_topic_shapes(self):
        for topic in ("msh/US/GA/2/map/", "msh/US/GA/2/stat/!aabb", "msh/US/GA/2/json/x"):
            assert channels.name_from_topic(topic) is None

    def test_missing_and_malformed(self):
        assert channels.name_from_topic("") is None
        assert channels.name_from_topic("msh/US/GA/2/e") is None
        assert channels.name_from_topic("msh/US/GA/2/e//!aabb") is None
        assert channels.name_from_topic("nonsense") is None
        assert channels.name_from_topic("/" * 200) is None

    def test_channel_literally_named_e(self):
        assert channels.name_from_topic("msh/US/2/e/e/!aabb") == "e"


class TestResolver:
    def test_encrypted_passes_through_and_teaches(self):
        r = channels.ChannelResolver()
        # Whatever an encrypted uplink claims is returned verbatim — it is the
        # hash by definition, including values that look like slot indices.
        for raw in (0, 6, 8, 19, 31, 255):
            assert r.resolve(raw_channel=raw, is_encrypted=True, channel_name="C") == raw
        # But none of those conflicting sightings repeated, so the first one
        # learned still stands (see the corroboration tests below).
        assert r.resolve(raw_channel=3, is_encrypted=False, channel_name="C") == 0

    def test_decoded_index_remaps_to_learned_hash(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=8, is_encrypted=True, channel_name="LongFast")
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="LongFast") == 8
        assert r.resolve(raw_channel=3, is_encrypted=False, channel_name="LongFast") == 8

    def test_unlearned_name_keeps_raw_rather_than_guessing(self):
        """A merely-unmerged bucket is recoverable; a fabricated one is not."""
        r = channels.ChannelResolver()
        assert r.resolve(raw_channel=1, is_encrypted=False, channel_name="Test") == 1

    def test_decoded_without_name_keeps_raw(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=8, is_encrypted=True, channel_name="LongFast")
        for name in (None, ""):
            assert r.resolve(raw_channel=0, is_encrypted=False, channel_name=name) == 0

    def test_decoded_out_of_index_range_keeps_raw(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=8, is_encrypted=True, channel_name="LongFast")
        assert r.resolve(raw_channel=19, is_encrypted=False, channel_name="LongFast") == 19

    def test_pki_never_resolves(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=8, is_encrypted=True, channel_name="LongFast")
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="PKI") == 0
        # An encrypted PKI copy must not teach anything either.
        r.resolve(raw_channel=99, is_encrypted=True, channel_name="PKI")
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="PKI") == 0
        assert r.resolve(raw_channel=2, is_encrypted=False, channel_name="LongFast") == 8

    def test_pki_flag_wins_over_name(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=8, is_encrypted=True, channel_name="LongFast")
        assert (
            r.resolve(
                raw_channel=0, is_encrypted=False, channel_name="LongFast", is_pki=True
            )
            == 0
        )

    def test_table_is_lru_bounded(self):
        r = channels.ChannelResolver(max_entries=2)
        for name, h in (("a", 10), ("b", 20), ("c", 30)):
            r.resolve(raw_channel=h, is_encrypted=True, channel_name=name)
        # "a" evicted; "b" and "c" retained.
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="a") == 0
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="b") == 20
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="c") == 30

    def test_single_conflicting_sighting_does_not_move_a_learned_hash(self):
        """Observed in production: a gateway intermittently uplinks encrypted
        packets carrying channel 0 on a MediumFast topic. Under last-writer-wins
        that re-taught MediumFast -> 0 for ~84 ms."""
        r = channels.ChannelResolver()
        r.resolve(raw_channel=31, is_encrypted=True, channel_name="MediumFast")
        r.resolve(raw_channel=0, is_encrypted=True, channel_name="MediumFast")
        assert r.resolve(raw_channel=1, is_encrypted=False, channel_name="MediumFast") == 31

    def test_a_reaffirmation_clears_a_pending_conflict(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=31, is_encrypted=True, channel_name="MediumFast")
        r.resolve(raw_channel=0, is_encrypted=True, channel_name="MediumFast")   # pending
        r.resolve(raw_channel=31, is_encrypted=True, channel_name="MediumFast")  # reaffirm
        r.resolve(raw_channel=0, is_encrypted=True, channel_name="MediumFast")   # pending again
        assert r.resolve(raw_channel=1, is_encrypted=False, channel_name="MediumFast") == 31

    def test_two_consecutive_sightings_do_migrate_a_rekeyed_channel(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=31, is_encrypted=True, channel_name="MediumFast")
        r.resolve(raw_channel=77, is_encrypted=True, channel_name="MediumFast")
        r.resolve(raw_channel=77, is_encrypted=True, channel_name="MediumFast")
        assert r.resolve(raw_channel=1, is_encrypted=False, channel_name="MediumFast") == 77

    def test_first_sighting_of_a_low_hash_is_still_trusted(self):
        """'ares' hashes to 7 — a real hash inside the index range. The
        corroboration rule must not block establishing it in the first place."""
        r = channels.ChannelResolver()
        r.resolve(raw_channel=7, is_encrypted=True, channel_name="ares")
        assert r.resolve(raw_channel=2, is_encrypted=False, channel_name="ares") == 7

    def test_observe_rejects_out_of_range(self):
        r = channels.ChannelResolver()
        r.observe("x", 999)
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="x") == 0

    def test_seed_preloads_learned_names(self):
        """Startup seeding from chat_channels closes the cold-start window: a
        rare channel's first post-restart decoded packet must not misfile."""
        r = channels.ChannelResolver()
        loaded = r.seed({"MediumFast": 31, "SVComm": 43, "PKI": 80, "junk": 999})
        assert loaded == 2  # PKI and out-of-range skipped
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="MediumFast") == 31
        assert r.resolve(raw_channel=1, is_encrypted=False, channel_name="SVComm") == 43
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="PKI") == 0

    def test_seeded_entries_need_corroboration_to_change(self):
        r = channels.ChannelResolver()
        r.seed({"MediumFast": 31})
        # One conflicting sighting (one packet) does not move a seeded entry...
        r.resolve(raw_channel=0, is_encrypted=True, channel_name="MediumFast", packet_id=1)
        assert r.resolve(raw_channel=2, is_encrypted=False, channel_name="MediumFast") == 31
        # ...two distinct packets do.
        r.resolve(raw_channel=99, is_encrypted=True, channel_name="MediumFast", packet_id=2)
        r.resolve(raw_channel=99, is_encrypted=True, channel_name="MediumFast", packet_id=3)
        assert r.resolve(raw_channel=2, is_encrypted=False, channel_name="MediumFast") == 99

    def test_same_packet_id_never_corroborates(self):
        r = channels.ChannelResolver()
        r.seed({"MediumFast": 31})
        for _ in range(5):
            r.resolve(raw_channel=0, is_encrypted=True, channel_name="MediumFast", packet_id=777)
        assert r.resolve(raw_channel=2, is_encrypted=False, channel_name="MediumFast") == 31

    def test_encrypted_flap_copy_returns_learned_bucket(self):
        """Unit-level S1: an encrypted copy claiming an index-range value for a
        name whose learned hash is real files at the learned hash."""
        r = channels.ChannelResolver()
        r.seed({"MediumFast": 31})
        got = r.resolve(
            raw_channel=0, is_encrypted=True, channel_name="MediumFast", packet_id=5
        )
        assert got == 31


def _decoded_envelope(name, channel_value, text="hi", pkt_id=999001):
    """ServiceEnvelope carrying an already-decoded packet, as published by a
    gateway with mqtt.encryption_enabled = false — firmware has overwritten
    .channel with its local slot index by this point."""
    mp = mesh_pb2.MeshPacket()
    setattr(mp, "from", 0x67EA9401)
    mp.to = 0xFFFFFFFF
    mp.id = pkt_id
    mp.channel = channel_value
    mp.rx_time = 1700000000
    mp.decoded.portnum = portnums_pb2.TEXT_MESSAGE_APP
    mp.decoded.payload = text.encode("utf-8")

    se = mqtt_pb2.ServiceEnvelope()
    se.packet.CopyFrom(mp)
    se.channel_id = name
    se.gateway_id = "!67ea9400"
    return se.SerializeToString()


def _encrypted_envelope(
    name, channel_value, text="hi", pkt_id=999501, psk=DEFAULT_PSK, rx_time=1700000000
):
    """ServiceEnvelope carrying a genuinely AES-CTR encrypted packet, as
    published by a default-configured gateway — .channel is the real hash.
    Nonce layout must match mqtt.py: packet_id LE64 ‖ from LE64."""
    from_ = 0x67EA9401
    data = mesh_pb2.Data()
    data.portnum = portnums_pb2.TEXT_MESSAGE_APP
    data.payload = text.encode("utf-8")

    nonce = pkt_id.to_bytes(8, "little") + from_.to_bytes(8, "little")
    encryptor = Cipher(algorithms.AES(psk), modes.CTR(nonce)).encryptor()

    mp = mesh_pb2.MeshPacket()
    setattr(mp, "from", from_)
    mp.to = 0xFFFFFFFF
    mp.id = pkt_id
    mp.channel = channel_value
    mp.rx_time = rx_time
    mp.encrypted = encryptor.update(data.SerializeToString()) + encryptor.finalize()

    se = mqtt_pb2.ServiceEnvelope()
    se.packet.CopyFrom(mp)
    se.channel_id = name
    se.gateway_id = "!67ea9400"
    return se.SerializeToString()


def _topic(name):
    return f"msh/US/GA/2/e/{name}/!67ea9400"


def _buckets(data):
    return [chat["channel"] for _, chat in data.pg_storage.chat_writes]


class TestIngestEndToEnd:
    def test_encrypted_uplink_teaches_then_decoded_uplink_converges(self):
        """The regression this change exists for: the same channel relayed by an
        encrypting gateway (hash 8) and a decoding gateway (index 0) must not
        split across two buckets."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 8, pkt_id=2001))
        ))
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _decoded_envelope("LongFast", 0, pkt_id=2002))
        ))

        assert _buckets(data) == ["8", "8"]

    def test_assignment_not_setdefault(self):
        """Kills the mutant that restores the pre-fix `outs.setdefault(...)`.

        Needs a decoded index != 0: MessageToJson omits a zero channel, so with
        setdefault a 0 would still be filled in and the bucket would look right.
        """
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 8, pkt_id=2101))
        ))
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _decoded_envelope("LongFast", 3, pkt_id=2102))
        ))

        assert _buckets(data)[-1] == "8", "slot index 3 leaked through as its own bucket"

    def test_encrypted_flap_files_at_learned_until_corroborated(self):
        """A flapping gateway emits encrypted copies whose channel byte is an
        index-range value for a channel whose established hash is real (live:
        MediumFast copies carrying 0). One such copy must file with the channel,
        not the glitch — but a genuine re-key into 0-7 still lands once a
        SECOND, distinct packet corroborates it.
        """
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 8, pkt_id=2201))
        ))
        # Flap copy: claims 3, learned is 8 -> files at 8.
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 3, pkt_id=2202))
        ))
        assert _buckets(data)[-1] == "8", "single flap copy escaped the learned bucket"

        # Distinct packet repeats the claim: that is a re-key, not a flap.
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 3, pkt_id=2203))
        ))
        assert _buckets(data)[-1] == "3", "corroborated re-key was not honored"

    def test_double_publish_of_one_packet_cannot_confirm_a_change(self):
        """The live flap gateway publishes each packet twice ~330ms apart, so
        'two consecutive sightings' alone was satisfied by one flapped packet's
        two copies. Corroboration must require distinct packets."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("MediumFast"), _encrypted_envelope("MediumFast", 31, pkt_id=2211))
        ))
        # Same flapped packet, published twice by the same gateway.
        for _ in range(2):
            run(mqtt.process_mqtt_msg(
                None, FakeMsg(_topic("MediumFast"), _encrypted_envelope("MediumFast", 0, pkt_id=2212))
            ))
        # Decoded copy still resolves to the established hash.
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("MediumFast"), _decoded_envelope("MediumFast", 0, pkt_id=2213))
        ))
        assert _buckets(data)[-1] == "31", "one double-published packet re-taught the hash"

    def test_encrypted_low_hash_passes_through(self):
        """'ares' hashes to 7 on the default PSK — a real hash inside the index
        range, which must not be mistaken for a slot index."""
        assert channels.channel_hash("ares", DEFAULT_PSK) == 7
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("ares"), _encrypted_envelope("ares", 7, pkt_id=2301))
        ))

        assert _buckets(data) == ["7"]

    def test_name_recovered_from_topic_when_envelope_omits_it(self):
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("MediumFast"), _encrypted_envelope("", 31, pkt_id=2401))
        ))
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("MediumFast"), _decoded_envelope("", 0, pkt_id=2402))
        ))

        assert _buckets(data) == ["31", "31"]
        _, chat = data.pg_storage.chat_writes[-1]
        assert chat["channel_name"] == "MediumFast"

    def test_unnamed_decoded_packet_keeps_raw_bucket(self):
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg("msh/US/GA/2/e//!67ea9400", _decoded_envelope("", 0, pkt_id=2501))
        ))

        assert _buckets(data) == ["0"]

    def test_unset_rx_time_is_floored_at_arrival(self):
        """proto3 zero for rx_time used to store epoch 0, which renders as 1969
        and is filtered out by every range except 'all'."""
        import time as _time

        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])
        env = _encrypted_envelope("LongFast", 8, pkt_id=2701, rx_time=0)
        before = int(_time.time())

        run(mqtt.process_mqtt_msg(None, FakeMsg(_topic("LongFast"), env)))

        _, chat = data.pg_storage.chat_writes[-1]
        assert chat["timestamp"] >= before, "unset rx_time was not floored"

    def test_real_rx_time_is_preserved(self):
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])
        env = _encrypted_envelope("LongFast", 8, pkt_id=2702, rx_time=1700000000)

        run(mqtt.process_mqtt_msg(None, FakeMsg(_topic("LongFast"), env)))

        _, chat = data.pg_storage.chat_writes[-1]
        assert chat["timestamp"] == 1700000000

    def test_pki_dm_does_not_overwrite_last_channel(self):
        """A PKI DM belongs to no channel; its 0 sentinel must not flip the
        sender's bucket to Legacy every time they DM someone."""
        from mqtt import _node_channel

        assert _node_channel({"channel": 0, "channel_name": "PKI"}) is None
        assert _node_channel({"channel": 8, "channel_name": "LongFast"}) == "8"
        assert _node_channel({"channel": 0}) == "0"  # no name: keep legacy behavior
        assert _node_channel({}) is None

    def test_channel_name_reaches_the_chat_row(self):
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 8, pkt_id=2601))
        ))

        _, chat = data.pg_storage.chat_writes[-1]
        assert chat["channel_name"] == "LongFast"
