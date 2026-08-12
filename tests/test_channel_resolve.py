"""
Channel-bucket resolution tests (channels.py + its use in process_mqtt_msg).
MeshPacket.channel is a (name, PSK) hash on encrypted uplinks but a gateway
slot index (0-7) after decode; ingest must merge both into one bucket.
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
        """Pinned against firmware's preset names (DisplayFormatters.cpp), not the sample config."""
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
        """Legacy sample spellings hash to 9/55; documented for configs still carrying them."""
        assert channels.channel_hash("LongModerate", DEFAULT_PSK) == 9
        assert channels.channel_hash("VeryLongSlow", DEFAULT_PSK) == 55
        assert channels.channel_hash("LongMod", DEFAULT_PSK) != 9
        assert channels.channel_hash("LongTurbo", DEFAULT_PSK) != 55

    def test_xor_hash_of_default_psk(self):
        assert channels.xor_hash(DEFAULT_PSK) == 2

    def test_empty_name_is_not_a_preset(self):
        """Firmware never hashes a blank name — 2 is not 'unconfigured'."""
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
        # Encrypted claims are the hash by definition; those above the index
        # range pass through as-is.
        for raw in (8, 19, 31, 255):
            assert r.resolve(raw_channel=raw, is_encrypted=True, channel_name="C") == raw
        # No conflicting sighting repeated, so the first learned hash stands.
        assert r.resolve(raw_channel=3, is_encrypted=False, channel_name="C") == 8

    def test_named_encrypted_index_claim_files_at_the_name_bucket(self):
        """A hash of 0-6 can't be told from a slot index and can't hold a name."""
        r = channels.ChannelResolver()
        for raw in (0, 6):
            assert r.resolve(raw_channel=raw, is_encrypted=True, channel_name="C") == (
                channels.name_bucket_id("C")
            )

    def test_decoded_index_remaps_to_learned_hash(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=8, is_encrypted=True, channel_name="LongFast")
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="LongFast") == 8
        assert r.resolve(raw_channel=3, is_encrypted=False, channel_name="LongFast") == 8

    def test_unlearned_name_files_at_name_bucket_not_raw_index(self):
        """A decoded index carries no channel identity; the wire name does. Two
        channels sharing a slot must not conflate while their hashes are unknown."""
        r = channels.ChannelResolver()
        got = r.resolve(raw_channel=1, is_encrypted=False, channel_name="Test")
        assert got == channels.name_bucket_id("Test")
        # Same slot, different name -> different bucket.
        other = r.resolve(raw_channel=1, is_encrypted=False, channel_name="Test2")
        assert other == channels.name_bucket_id("Test2")
        assert got != other

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
        # "a" evicted -> unlearned again, so it files by name; "b"/"c" retained.
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="a") == (
            channels.name_bucket_id("a")
        )
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="b") == 20
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="c") == 30

    def test_single_conflicting_sighting_does_not_move_a_learned_hash(self):
        """Gateways can flap stray channel bytes; one sighting must not re-teach a hash."""
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

    def test_low_hash_channel_lives_at_its_name_bucket(self):
        """'ares' hashes to 7 — a real hash, but indistinguishable from a slot
        index and unable to carry a name in storage, so the name bucket wins.
        Both uplink kinds must agree or the channel splits."""
        r = channels.ChannelResolver()
        want = channels.name_bucket_id("ares")
        assert r.resolve(raw_channel=7, is_encrypted=True, channel_name="ares") == want
        assert r.resolve(raw_channel=2, is_encrypted=False, channel_name="ares") == want

    def test_observe_rejects_out_of_range(self):
        r = channels.ChannelResolver()
        r.observe("x", 999)
        # Nothing learned, so the decoded copy files by name, not at 999.
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="x") == (
            channels.name_bucket_id("x")
        )

    def test_seed_preloads_learned_names(self):
        """Seeding from chat_channels closes the post-restart cold-start misfile window."""
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
        """An encrypted copy claiming an index-range value files at the learned hash."""
        r = channels.ChannelResolver()
        r.seed({"MediumFast": 31})
        got = r.resolve(
            raw_channel=0, is_encrypted=True, channel_name="MediumFast", packet_id=5
        )
        assert got == 31


class TestNameBuckets:
    def test_derivation_is_stable_int32_and_disjoint_from_hashes(self):
        b = channels.name_bucket_id("GSMC Tech")
        assert b == channels.name_bucket_id("GSMC Tech")  # deterministic
        # Outside the 8-bit hash space, positive int32 (INTEGER columns), and
        # at most 10 digits (chat_channels.id is VARCHAR(10)).
        assert b > channels.MAX_CHANNEL_HASH
        assert channels.NAME_BUCKET_FLAG <= b <= 0x7FFF_FFFF
        assert len(str(b)) <= 10
        assert channels.is_name_bucket(b)
        assert not channels.is_name_bucket(255)

    def test_normalize_wire_name(self):
        assert channels.normalize_wire_name("  GSMC Tech\x00 ") == "GSMC Tech"
        assert channels.normalize_wire_name("x" * 200) == "x" * 100
        assert channels.normalize_wire_name("\x00 ") is None
        assert channels.normalize_wire_name("") is None
        assert channels.normalize_wire_name(None) is None

    def test_unnamed_encrypted_index_claim_passes_through(self):
        """Only NAMED channels move to name buckets; a nameless copy keeps raw."""
        r = channels.ChannelResolver()
        assert r.resolve(raw_channel=7, is_encrypted=True, channel_name=None) == 7

    def test_decoded_files_at_learned_hash_once_taught(self):
        r = channels.ChannelResolver()
        syn = r.resolve(raw_channel=0, is_encrypted=False, channel_name="SVComm")
        assert syn == channels.name_bucket_id("SVComm")
        r.resolve(raw_channel=43, is_encrypted=True, channel_name="SVComm")
        assert r.resolve(raw_channel=0, is_encrypted=False, channel_name="SVComm") == 43


class TestLearnEvents:
    def test_first_learn_emits_one_event_and_drain_clears(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=43, is_encrypted=True, channel_name="SVComm", packet_id=1)
        assert r.drain_learn_events() == [("SVComm", 43)]
        assert r.drain_learn_events() == []

    def test_reaffirmation_does_not_emit(self):
        r = channels.ChannelResolver()
        r.resolve(raw_channel=43, is_encrypted=True, channel_name="SVComm", packet_id=1)
        r.drain_learn_events()
        r.resolve(raw_channel=43, is_encrypted=True, channel_name="SVComm", packet_id=2)
        assert r.drain_learn_events() == []

    def test_corroborated_rekey_emits(self):
        r = channels.ChannelResolver()
        r.seed({"MediumFast": 31})
        r.resolve(raw_channel=99, is_encrypted=True, channel_name="MediumFast", packet_id=2)
        r.resolve(raw_channel=99, is_encrypted=True, channel_name="MediumFast", packet_id=3)
        assert r.drain_learn_events() == [("MediumFast", 99)]

    def test_seed_does_not_emit(self):
        """Seeded names were healed when first learned; re-healing every restart
        would hammer the tables for nothing."""
        r = channels.ChannelResolver()
        r.seed({"MediumFast": 31, "SVComm": 43})
        assert r.drain_learn_events() == []

    def test_index_range_hash_emits_nothing(self):
        """'ares' stays at its name bucket, so there is no bucket to merge."""
        r = channels.ChannelResolver()
        r.resolve(raw_channel=7, is_encrypted=True, channel_name="ares", packet_id=1)
        assert r.drain_learn_events() == []

    def test_requeue_survives_a_failed_merge(self):
        """A reaffirmation never re-emits, so a dropped event would strand the
        name bucket permanently — the retry has to come from the queue."""
        r = channels.ChannelResolver()
        r.resolve(raw_channel=43, is_encrypted=True, channel_name="SVComm", packet_id=1)
        (name, h), = r.drain_learn_events()
        r.requeue_learn_event(name, h)          # merge failed
        r.requeue_learn_event(name, h)          # idempotent, no duplicate work
        assert r.drain_learn_events() == [("SVComm", 43)]


def _decoded_envelope(name, channel_value, text="hi", pkt_id=999001):
    """Decoded-gateway ServiceEnvelope — .channel is the gateway's local slot index."""
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
    """AES-CTR encrypted ServiceEnvelope — .channel is the real hash.
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
        """One channel relayed as hash 8 and index 0 must not split across buckets."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 8, pkt_id=2001))
        ))
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _decoded_envelope("LongFast", 0, pkt_id=2002))
        ))

        assert _buckets(data) == ["8", "8"]

    def test_assignment_not_setdefault(self):
        """Needs a decoded index != 0: MessageToJson omits a zero channel, so a
        regressed setdefault would still look right for 0."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 8, pkt_id=2101))
        ))
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _decoded_envelope("LongFast", 3, pkt_id=2102))
        ))

        assert _buckets(data)[-1] == "8", "slot index 3 leaked through as its own bucket"

    def test_encrypted_flap_files_at_learned_until_corroborated(self):
        """One flapped copy files at the learned hash; a second distinct packet
        corroborates a genuine re-key into 0-7."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 8, pkt_id=2201))
        ))
        # Flap copy: claims 3, learned is 8 -> files at 8.
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 3, pkt_id=2202))
        ))
        assert _buckets(data)[-1] == "8", "single flap copy escaped the learned bucket"

        # Distinct packet repeats the claim: that is a re-key, not a flap. The
        # new hash is in the index range, so the channel moves to its name
        # bucket rather than into the shared slot bucket.
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("LongFast"), _encrypted_envelope("LongFast", 3, pkt_id=2203))
        ))
        assert _buckets(data)[-1] == str(channels.name_bucket_id("LongFast")), (
            "corroborated re-key was not honored"
        )

    def test_double_publish_of_one_packet_cannot_confirm_a_change(self):
        """Gateways can publish one packet twice; corroboration must require distinct packets."""
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
        """proto3 zero rx_time stored epoch 0 — renders as 1969, hidden by every range but 'all'."""
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
        """PKI DMs carry no channel; the 0 sentinel must not flip the sender's bucket."""
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

    def test_decode_only_channels_sharing_a_slot_get_distinct_name_buckets(self):
        """The GSMC case: a decode-only gateway publishes two channels' packets
        with channel=0; the topic name must separate them, not the slot."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("GSMC Tech"), _decoded_envelope("GSMC Tech", 0, pkt_id=2801))
        ))
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("GSMC Main"), _decoded_envelope("GSMC Main", 0, pkt_id=2802))
        ))

        tech = str(channels.name_bucket_id("GSMC Tech"))
        main = str(channels.name_bucket_id("GSMC Main"))
        assert _buckets(data) == [tech, main]
        assert tech != main
        _, chat = data.pg_storage.chat_writes[-1]
        assert chat["channel_name"] == "GSMC Main"

    def test_learning_the_hash_merges_the_name_bucket(self):
        """Decoded rows pile up in the name bucket; the first encrypted sighting
        teaches the hash, triggers the storage merge, and re-files new traffic."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("SVComm"), _decoded_envelope("SVComm", 2, pkt_id=2901))
        ))
        assert _buckets(data) == [str(channels.name_bucket_id("SVComm"))]
        assert data.pg_storage.rebucket_calls == []

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("SVComm"), _encrypted_envelope("SVComm", 43, pkt_id=2902))
        ))
        assert data.pg_storage.rebucket_calls == [("SVComm", 43)]

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("SVComm"), _decoded_envelope("SVComm", 2, pkt_id=2903))
        ))
        assert _buckets(data)[-1] == "43"
        # Reaffirmations must not re-run the merge.
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("SVComm"), _encrypted_envelope("SVComm", 43, pkt_id=2904))
        ))
        assert data.pg_storage.rebucket_calls == [("SVComm", 43)]

    def test_low_hash_channel_does_not_ping_pong_between_bucket_7_and_its_name(self):
        """'ares' hashes to 7. Encrypted and decoded copies must agree on the
        name bucket, or ingest and the backfill fight over the rows forever."""
        assert channels.channel_hash("ares", DEFAULT_PSK) == 7
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("ares"), _decoded_envelope("ares", 0, pkt_id=2971))
        ))
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("ares"), _encrypted_envelope("ares", 7, pkt_id=2972))
        ))

        want = str(channels.name_bucket_id("ares"))
        assert _buckets(data) == [want, want]
        assert data.pg_storage.rebucket_calls == [], "merged into the slot-index bucket"

    def test_name_bucket_label_is_written_for_node_only_traffic(self):
        """chat_channels rows come from chat writes; without this a telemetry-only
        channel renders as a bare 10-digit id."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("GSMC Tech"), _decoded_envelope("GSMC Tech", 0, pkt_id=2981))
        ))

        bucket = str(channels.name_bucket_id("GSMC Tech"))
        assert data.pg_storage.label_calls == [(bucket, "GSMC Tech")]

        # One write per bucket per process, not per packet.
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("GSMC Tech"), _decoded_envelope("GSMC Tech", 0, pkt_id=2982))
        ))
        assert data.pg_storage.label_calls == [(bucket, "GSMC Tech")]

    def test_stranded_sweep_merges_repopulated_name_buckets(self):
        """The learn-event merge fires once, but a name bucket can repopulate
        afterwards (write-retry replay, backfill race, failed merge + restart).
        The sweep re-merges any bucket whose name has a learned hash."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])
        mqtt._channel_resolver.seed({"SVComm": 43, "ares": 7})
        data.pg_storage.name_bucket_names = ["SVComm", "ares", "NeverLearned"]

        run(mqtt._merge_stranded_name_buckets())

        # Learned hash -> merged; hash <= 7 is the bucket's permanent home;
        # unlearned names have nowhere to go.
        assert data.pg_storage.rebucket_calls == [("SVComm", 43)]

    def test_sweep_survives_a_failing_merge(self):
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])
        mqtt._channel_resolver.seed({"A": 43, "B": 44})
        data.pg_storage.name_bucket_names = ["A", "B"]

        async def boom(name, learned_hash):
            data.pg_storage.rebucket_calls.append((name, learned_hash))
            if name == "A":
                raise RuntimeError("db blip")
        data.pg_storage.rebucket_name_channel = boom

        run(mqtt._merge_stranded_name_buckets())
        # B still merged after A failed.
        assert ("B", 44) in data.pg_storage.rebucket_calls

    def test_label_is_rewritten_after_a_merge_drops_the_row(self):
        """The merge deletes the label row; a name that later re-derives its
        bucket (LRU eviction, re-key into 0-7) must write it again."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])
        bucket = str(channels.name_bucket_id("SVComm"))

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("SVComm"), _decoded_envelope("SVComm", 0, pkt_id=2961))
        ))
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("SVComm"), _encrypted_envelope("SVComm", 43, pkt_id=2962))
        ))
        assert data.pg_storage.rebucket_calls == [("SVComm", 43)]

        # Name falls out of the resolver, so the bucket is derived again.
        mqtt._channel_resolver = channels.ChannelResolver()
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("SVComm"), _decoded_envelope("SVComm", 0, pkt_id=2963))
        ))
        assert data.pg_storage.label_calls == [
            (bucket, "SVComm"), (bucket, "SVComm")
        ], "stale cache entry suppressed the label rewrite"

    def test_failed_merge_is_retried_on_the_next_packet(self):
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])
        data.pg_storage.rebucket_fail_times = 1

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("SVComm"), _encrypted_envelope("SVComm", 43, pkt_id=2991))
        ))
        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("SVComm"), _encrypted_envelope("SVComm", 43, pkt_id=2992))
        ))

        assert data.pg_storage.rebucket_calls == [("SVComm", 43), ("SVComm", 43)]

    def test_wire_name_is_normalized_before_resolution(self):
        """Padded envelope names must not fork a second bucket or miss the seed."""
        mqtt, data = make_mqtt_pb([DEFAULT_PSK_B64])

        run(mqtt.process_mqtt_msg(
            None, FakeMsg(_topic("GSMC Tech"), _decoded_envelope(" GSMC Tech ", 0, pkt_id=2951))
        ))

        assert _buckets(data) == [str(channels.name_bucket_id("GSMC Tech"))]
        _, chat = data.pg_storage.chat_writes[-1]
        assert chat["channel_name"] == "GSMC Tech"
