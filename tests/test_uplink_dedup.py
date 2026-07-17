"""
Tests for storage.db.uplink_dedup — the lossless uplink-dedup helpers (#526).

The invariant under test: for any gateway copy of a mesh packet,
reconstruct_copy(canonical, gateway, topic, fields, patch) must reproduce the
original copy's dict exactly, where patch = reception_patch(template, copy).
"""

import copy

from storage.db.uplink_dedup import (
    PER_COPY_KEYS,
    UplinkDedupCache,
    coerce_packet_id,
    gateway_from_msg,
    reception_fields,
    reception_patch,
    reception_template,
    reconstruct_copy,
)


def _copy_from_gateway(base, sender, topic, rssi, snr, hop_limit, extra=None):
    """A realistic uplink copy: shared packet content + per-gateway envelope."""
    msg = dict(base)
    msg.update(
        {
            "sender": sender,
            "topic": topic,
            "rx_rssi": rssi,
            "rssi": rssi,
            "rx_snr": snr,
            "snr": snr,
            "rx_time": 1779438295,
            "timestamp": 1779438295,
            "hop_limit": hop_limit,
            "hops_away": 7 - hop_limit,
            "relay_node": 16,
            "qos": 0,
            "retain": False,
        }
    )
    if extra:
        msg.update(extra)
    return msg


BASE = {
    "channel": 31,
    "from": "1f1ffa8b",
    "to": "ffffffff",
    "id": 1958769671,
    "hop_start": 7,
    "type": "telemetry",
    "payload": {"temperature": 21.5, "voltage": 4.01},
}

CANONICAL = _copy_from_gateway(BASE, "eb401fff", "msh/US/CA/sacvalley/2/e/MediumFast/!eb401fff", -60, 10.25, 1)


def _roundtrip(dup):
    """Write-side patch + read-side reconstruction for one copy."""
    gateway = gateway_from_msg(dup)
    topic = dup.get("topic")
    fields = reception_fields(dup)
    patch = reception_patch(reception_template(CANONICAL, gateway, topic, fields), dup)
    return reconstruct_copy(CANONICAL, gateway, topic, fields, patch), patch


class TestLosslessRoundtrip:
    def test_plain_gateway_copy_needs_no_patch(self):
        dup = _copy_from_gateway(BASE, "b2a73f10", "msh/US/CA/sacvalley/2/e/MediumFast/!b2a73f10", -113, -3.75, 0)
        rebuilt, patch = _roundtrip(dup)
        assert patch is None
        assert rebuilt == dup

    def test_copy_with_stray_field_roundtrips(self):
        # The production oddity: one gateway's copy carried priority=64.
        dup = _copy_from_gateway(
            BASE, "7e273c82", "msh/US/bayarea/2/e/MediumFast/!7e273c82",
            -90, 2.5, 3, extra={"priority": 64, "transport_mechanism": 6},
        )
        rebuilt, patch = _roundtrip(dup)
        assert patch is not None and "priority" in patch["set"]
        assert rebuilt == dup

    def test_copy_missing_invariant_key_roundtrips(self):
        dup = _copy_from_gateway(BASE, "a2ea272c", "msh/US/bayarea/2/e/MediumFast/!a2ea272c", -80, 5.0, 2)
        del dup["hop_start"]
        rebuilt, patch = _roundtrip(dup)
        assert "hop_start" in patch["del"]
        assert rebuilt == dup

    def test_clamped_timestamp_roundtrips(self):
        # Ingest clamps timestamp when the node clock runs ahead of rx_time.
        dup = _copy_from_gateway(BASE, "b2a73f10", "msh/US/CA/sacvalley/2/e/MediumFast/!b2a73f10", -70, 8.0, 4)
        dup["timestamp"] = dup["rx_time"] - 3600
        rebuilt, patch = _roundtrip(dup)
        assert patch["set"]["timestamp"] == dup["timestamp"]
        assert rebuilt == dup

    def test_copy_with_divergent_alias_roundtrips(self):
        dup = _copy_from_gateway(BASE, "b2a73f10", "msh/US/CA/sacvalley/2/e/MediumFast/!b2a73f10", -70, 8.0, 4)
        dup["rssi"] = -71  # alias disagrees with rx_rssi
        rebuilt, patch = _roundtrip(dup)
        assert rebuilt == dup

    def test_json_gateway_copy_without_aliases_roundtrips(self):
        # JSON-publisher copies may omit sender and the rssi/snr aliases.
        dup = _copy_from_gateway(BASE, "b2a73f10", "msh/US/CA/sacvalley/2/json/MediumFast/!b2a73f10", -99, 1.0, 5)
        for k in ("sender", "rssi", "snr"):
            del dup[k]
        canonical_no_alias = dict(CANONICAL)
        for k in ("sender", "rssi", "snr"):
            del canonical_no_alias[k]
        gateway = gateway_from_msg(dup)
        fields = reception_fields(dup)
        template = reception_template(canonical_no_alias, gateway, dup["topic"], fields)
        # Canonical lacks the keys -> template must not invent them.
        assert "sender" not in template and "rssi" not in template
        patch = reception_patch(template, dup)
        assert reconstruct_copy(canonical_no_alias, gateway, dup["topic"], fields, patch) == dup

    def test_smallint_overflow_falls_back_to_patch(self):
        dup = _copy_from_gateway(BASE, "b2a73f10", "msh/US/CA/sacvalley/2/e/MediumFast/!b2a73f10", -70, 8.0, 4)
        dup["hop_limit"] = 2 ** 20  # exceeds the SMALLINT column
        rebuilt, patch = _roundtrip(dup)
        assert reception_fields(dup)["hop_limit"] is None
        assert rebuilt == dup

    def test_field_missing_on_canonical_needs_no_patch(self):
        # Protobuf omits default-valued fields, so a copy often carries keys
        # the canonical lacks (e.g. relay_node) — the column alone covers them.
        dup = _copy_from_gateway(BASE, "b2a73f10", "msh/US/CA/sacvalley/2/e/MediumFast/!b2a73f10", -70, 8.0, 4)
        canonical = {k: v for k, v in CANONICAL.items() if k != "relay_node"}
        gateway = gateway_from_msg(dup)
        fields = reception_fields(dup)
        template = reception_template(canonical, gateway, dup["topic"], fields)
        patch = reception_patch(template, dup)
        assert patch is None
        assert reconstruct_copy(canonical, gateway, dup["topic"], fields, patch) == dup

    def test_canonical_copy_roundtrips_against_itself(self):
        rebuilt, patch = _roundtrip(dict(CANONICAL))
        assert patch is None
        assert rebuilt == CANONICAL

    def test_roundtrip_does_not_mutate_inputs(self):
        dup = _copy_from_gateway(BASE, "b2a73f10", "msh/x/!b2a73f10", -70, 8.0, 4)
        canonical_before = copy.deepcopy(CANONICAL)
        dup_before = copy.deepcopy(dup)
        _roundtrip(dup)
        assert CANONICAL == canonical_before and dup == dup_before


class TestFieldHelpers:
    def test_coerce_packet_id(self):
        assert coerce_packet_id(1958769671) == 1958769671
        assert coerce_packet_id("1958769671") == 1958769671
        assert coerce_packet_id(True) is None
        assert coerce_packet_id(None) is None
        assert coerce_packet_id("!abc") is None
        assert coerce_packet_id(-5) is None
        assert coerce_packet_id(2 ** 63) is None
        # id 0 is Meshtastic's 'unset' — two id-0 packets are NOT copies.
        assert coerce_packet_id(0) is None
        assert coerce_packet_id("0") is None

    def test_gateway_prefers_sender_over_topic(self):
        assert gateway_from_msg({"sender": "eb401fff", "topic": "msh/x/!b2a73f10"}) == "eb401fff"
        assert gateway_from_msg({"topic": "msh/x/!b2a73f10"}) == "b2a73f10"
        assert gateway_from_msg({"topic": "msh/no/gateway"}) is None
        assert gateway_from_msg({}) is None

    def test_reception_fields_uses_aliases_when_primary_missing(self):
        fields = reception_fields({"rssi": -60, "snr": 10.25, "timestamp": 123})
        assert fields["rx_rssi"] == -60
        assert fields["rx_snr"] == 10.25
        assert fields["rx_time"] == 123

    def test_per_copy_keys_cover_the_envelope(self):
        for key in ("sender", "topic", "rx_rssi", "rx_snr", "rx_time",
                    "hop_limit", "hops_away", "relay_node", "transport_mechanism",
                    "rssi", "snr", "timestamp", "qos", "retain"):
            assert key in PER_COPY_KEYS


class TestUplinkDedupCache:
    def test_hit_within_window(self):
        cache = UplinkDedupCache(window_seconds=900)
        cache.put(("aa", 1), 42, {"id": 1}, now=1000.0)
        assert cache.get(("aa", 1), now=1500.0) == (42, {"id": 1})

    def test_expires_after_window(self):
        cache = UplinkDedupCache(window_seconds=900)
        cache.put(("aa", 1), 42, {"id": 1}, now=1000.0)
        assert cache.get(("aa", 1), now=1901.0) is None

    def test_ttl_override_shortens_horizon(self):
        # DB-adopted canonical rows carry only the window's remaining time.
        cache = UplinkDedupCache(window_seconds=900)
        cache.put(("aa", 1), 42, {"id": 1}, now=1000.0, ttl=100.0)
        assert cache.get(("aa", 1), now=1050.0) == (42, {"id": 1})
        assert cache.get(("aa", 1), now=1101.0) is None

    def test_ttl_expired_entry_not_stored(self):
        cache = UplinkDedupCache(window_seconds=900)
        cache.put(("aa", 1), 42, {"id": 1}, now=1000.0, ttl=-5.0)
        assert cache.get(("aa", 1), now=1000.0) is None

    def test_short_ttl_entry_expires_despite_older_neighbors(self):
        # Out-of-order deadlines: the head purge alone would miss this entry.
        cache = UplinkDedupCache(window_seconds=900)
        cache.put(("aa", 1), 1, {}, now=1000.0)
        cache.put(("bb", 2), 2, {}, now=1001.0, ttl=10.0)
        assert cache.get(("bb", 2), now=1020.0) is None
        assert cache.get(("aa", 1), now=1020.0) == (1, {})

    def test_max_entries_evicts_oldest(self):
        cache = UplinkDedupCache(window_seconds=900, max_entries=2)
        cache.put(("aa", 1), 1, {}, now=1000.0)
        cache.put(("bb", 2), 2, {}, now=1001.0)
        cache.put(("cc", 3), 3, {}, now=1002.0)
        assert cache.get(("aa", 1), now=1003.0) is None
        assert cache.get(("cc", 3), now=1003.0) == (3, {})
