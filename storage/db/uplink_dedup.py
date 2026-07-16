#!/usr/bin/env python3
"""
Uplink dedup for the mqtt_messages raw archive (issue #526).

Every gateway that hears a mesh packet uplinks its own copy (~10x fan-out whose
decoded content is byte-identical; only the RF envelope differs). Ingest keeps
ONE canonical mqtt_messages row per logical packet — the first-heard copy,
stored verbatim — and records every uplink (including the first) as a narrow
packet_receptions row. Losslessness contract: each original copy must be
exactly reconstructible as

    reception_template(canonical, gateway, topic, fields)  +  extras patch

so `reception_patch` captures any deviation from the template at write time,
and `reconstruct_copy` replays it. Template and patch MUST stay in sync — a
template change invalidates previously stored patches.
"""

import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

from utils import normalize_node_id

# Envelope keys that vary per uplink copy; everything else in a message dict is
# packet-invariant and reconstructed from the canonical row's payload.
PER_COPY_KEYS = frozenset({
    "sender", "topic", "qos", "retain",
    "rx_rssi", "rx_snr", "rx_time",
    "rssi", "snr", "timestamp",  # legacy aliases of rx_rssi/rx_snr/rx_time
    "hop_limit", "hops_away", "relay_node", "transport_mechanism",
})

# (message key, reception column, lo, hi) for the integer envelope fields.
_INT_FIELDS = (
    ("rx_rssi", "rx_rssi", -32768, 32767),
    ("rx_time", "rx_time", -(2 ** 63), 2 ** 63 - 1),
    ("hop_limit", "hop_limit", -32768, 32767),
    ("hops_away", "hops_away", -32768, 32767),
    ("relay_node", "relay_node", -(2 ** 31), 2 ** 31 - 1),
    ("transport_mechanism", "transport", -32768, 32767),
)


def coerce_packet_id(value: Any) -> Optional[int]:
    """Mesh packet id as int, or None. Bools, non-numeric input, and id 0
    (Meshtastic's 'unset' — two id-0 packets are NOT copies) are rejected."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if 0 < value < 2 ** 63 else None
    if isinstance(value, str) and value.isdigit():
        v = int(value)
        return v if 0 < v < 2 ** 63 else None
    return None


def contains_nul(value: Any) -> bool:
    """True if any string in the structure carries a real NUL character —
    json.dumps renders it as a \\u0000 escape, which Postgres jsonb rejects."""
    if isinstance(value, str):
        return "\x00" in value
    if isinstance(value, dict):
        return any(contains_nul(k) or contains_nul(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return any(contains_nul(v) for v in value)
    return False


def _lossless_int(value: Any, lo: int, hi: int) -> Optional[int]:
    """int(value) only when the conversion loses nothing and fits the column."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        v = value
    elif isinstance(value, float) and value.is_integer():
        v = int(value)
    elif isinstance(value, str):
        try:
            v = int(value)
        except ValueError:
            return None
    else:
        return None
    return v if lo <= v <= hi else None


def _as_float(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def gateway_from_msg(msg: Dict[str, Any]) -> Optional[str]:
    """Uplinking gateway id: the envelope `sender`, else the topic's !suffix."""
    gw = normalize_node_id(msg.get("sender"))
    if gw is not None:
        return gw
    topic = msg.get("topic")
    if isinstance(topic, str) and "!" in topic:
        return normalize_node_id(topic.rsplit("!", 1)[1])
    return None


def reception_fields(msg: Dict[str, Any]) -> Dict[str, Any]:
    """Typed packet_receptions column values for one uplink copy."""
    fields: Dict[str, Any] = {}
    for key, col, lo, hi in _INT_FIELDS:
        fields[col] = _lossless_int(msg.get(key), lo, hi)
    # Legacy aliases fill in when the primary key is missing (JSON gateways).
    if fields["rx_rssi"] is None:
        fields["rx_rssi"] = _lossless_int(msg.get("rssi"), -32768, 32767)
    if fields["rx_time"] is None:
        fields["rx_time"] = _lossless_int(msg.get("timestamp"), -(2 ** 63), 2 ** 63 - 1)
    snr = _as_float(msg.get("rx_snr"))
    fields["rx_snr"] = snr if snr is not None else _as_float(msg.get("snr"))
    return fields


def reception_template(
    canonical: Dict[str, Any],
    gateway: Optional[str],
    topic: Optional[str],
    fields: Dict[str, Any],
) -> Dict[str, Any]:
    """The message dict a reception reconstructs to before its extras patch.

    The typed RF fields are emitted whenever the reception recorded a value —
    a non-NULL column implies the copy carried that key (protobuf omits
    default-valued fields, so copies routinely have keys the canonical lacks).
    sender/qos/retain and the legacy aliases follow the canonical copy's key
    presence instead: their columns/values can't distinguish presence. The
    extras patch corrects any exception either way.
    """
    out = {k: v for k, v in canonical.items() if k not in PER_COPY_KEYS}

    def put(key: str, value: Any, require_canonical: bool = True) -> None:
        if value is None or (require_canonical and key not in canonical):
            return
        out[key] = value

    put("topic", topic)
    put("sender", gateway)
    put("qos", canonical.get("qos"))
    put("retain", canonical.get("retain"))
    put("rx_rssi", fields.get("rx_rssi"), require_canonical=False)
    put("rx_snr", fields.get("rx_snr"), require_canonical=False)
    put("rx_time", fields.get("rx_time"), require_canonical=False)
    put("hop_limit", fields.get("hop_limit"), require_canonical=False)
    put("hops_away", fields.get("hops_away"), require_canonical=False)
    put("relay_node", fields.get("relay_node"), require_canonical=False)
    put("transport_mechanism", fields.get("transport"), require_canonical=False)
    # Aliases mirror the primary fields; the patch corrects e.g. clamped timestamps.
    put("rssi", fields.get("rx_rssi"))
    put("snr", fields.get("rx_snr"))
    put("timestamp", fields.get("rx_time"))
    return out


def reception_patch(
    template: Dict[str, Any], actual: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Minimal {'set': {...}, 'del': [...]} patch turning template into actual."""
    sets = {k: v for k, v in actual.items() if k not in template or template[k] != v}
    dels = [k for k in template if k not in actual]
    if not sets and not dels:
        return None
    patch: Dict[str, Any] = {}
    if sets:
        patch["set"] = sets
    if dels:
        patch["del"] = dels
    return patch


def reconstruct_copy(
    canonical: Dict[str, Any],
    gateway: Optional[str],
    topic: Optional[str],
    fields: Dict[str, Any],
    extras: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Rebuild the original uplink copy from its reception row (see module doc)."""
    out = reception_template(canonical, gateway, topic, fields)
    if extras:
        for k in extras.get("del", []):
            out.pop(k, None)
        out.update(extras.get("set", {}))
    return out


class UplinkDedupCache:
    """TTL map (from_node_id, packet_id) -> (row_id, canonical dict).

    Single-writer only (the MQTT loop awaits one insert at a time). The TTL is
    anchored at first sight and never refreshed on hit, matching the DB
    fallback's `created_at > now() - window` semantics.
    """

    def __init__(self, window_seconds: int = 900, max_entries: int = 20000):
        self.window = float(window_seconds)
        self.max_entries = int(max_entries)
        # key -> (expiry deadline, row_id, canonical dict); insertion-ordered,
        # so expired entries cluster at the head.
        self._entries: "OrderedDict[Tuple[str, int], Tuple[float, int, Dict[str, Any]]]" = OrderedDict()

    def _purge(self, now: float) -> None:
        while self._entries:
            _, (deadline, _, _) = next(iter(self._entries.items()))
            if deadline > now:
                break
            self._entries.popitem(last=False)

    def get(self, key: Tuple[str, int], now: Optional[float] = None) -> Optional[Tuple[int, Dict[str, Any]]]:
        now = time.monotonic() if now is None else now
        self._purge(now)
        entry = self._entries.get(key)
        # Deadlines aren't strictly insertion-ordered (ttl overrides), so the
        # head purge can miss this entry — check its own deadline too.
        if entry is None or entry[0] <= now:
            if entry is not None:
                del self._entries[key]
            return None
        return entry[1], entry[2]

    def put(
        self,
        key: Tuple[str, int],
        row_id: int,
        canonical: Dict[str, Any],
        now: Optional[float] = None,
        ttl: Optional[float] = None,
    ) -> None:
        """ttl overrides the window — used when re-adopting an existing canonical
        row from the DB so its total dedup horizon never exceeds one window."""
        now = time.monotonic() if now is None else now
        self._purge(now)
        remaining = self.window if ttl is None else ttl
        if remaining <= 0:
            return
        self._entries[key] = (now + remaining, row_id, canonical)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)
