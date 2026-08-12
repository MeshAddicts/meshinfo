#!/usr/bin/env python3
"""Meshtastic channel identity resolution: ``MeshPacket.channel`` is the 8-bit
(name, PSK) hash on encrypted uplinks but a gateway-local slot index (0-7) on
decoded ones; ChannelResolver learns name -> hash off the wire to remap indices.
Decoded uplinks whose name has no learned hash file under a name-keyed bucket
(the wire name is authoritative; the index is not) and merge into the real hash
if one is ever observed."""

import logging
import zlib
from collections import OrderedDict
from functools import reduce
from operator import xor
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Firmware MAX_NUM_CHANNELS is 8, so a slot index is always 0-7.
MAX_CHANNEL_INDEX = 7

# Real (name, PSK) hashes are 8-bit.
MAX_CHANNEL_HASH = 255

# Pseudo-channel gateways stamp on PKI DMs; no real channel behind it to resolve.
PKI_CHANNEL = "PKI"

# Name-keyed buckets live at 0x40000000 | crc32(name)&0x3FFFFFFF: disjoint from
# real hashes, positive int32 (telemetry/traceroutes.channel are INTEGER), and
# at most 10 digits (chat_channels.id is VARCHAR(10)).
NAME_BUCKET_FLAG = 0x4000_0000


def normalize_wire_name(name: Optional[str]) -> Optional[str]:
    """Canonical wire name: NUL-stripped, trimmed, DB-length-capped, else None.
    Every consumer (resolver keys, bucket derivation, stored channel_name) must
    see the same spelling or one channel splits into several buckets."""
    if not name:
        return None
    return name.replace("\x00", "").strip()[:100] or None


def name_bucket_id(name: str) -> int:
    """Stable synthetic bucket for a wire name with no learned hash."""
    return NAME_BUCKET_FLAG | (zlib.crc32(name.encode("utf-8")) & 0x3FFF_FFFF)


def is_name_bucket(bucket: int) -> bool:
    return bucket >= NAME_BUCKET_FLAG


def xor_hash(data: bytes) -> int:
    """Firmware's xorHash: a byte-wise XOR fold."""
    return reduce(xor, data, 0)


def channel_hash(name: str, psk: bytes) -> int:
    """Firmware's Channels::generateHash — xorHash(name) ^ xorHash(psk); kept for
    offline re-resolution. `name` is the effective name ("LongFast" when blank)."""
    return xor_hash(name.encode("utf-8")) ^ xor_hash(psk)


def name_from_topic(topic: str) -> Optional[str]:
    """Channel name from an `.../2/e/<name>/<gateway>` topic, else None.
    Fallback only; `ServiceEnvelope.channel_id` is the primary source."""
    if not topic:
        return None
    parts = topic.split("/")
    for i in range(len(parts) - 2):
        if parts[i] == "2" and parts[i + 1] == "e":
            return parts[i + 2] or None
    return None


class ChannelResolver:
    """Maps gateway slot indices back to channel hashes, learning from encrypted
    uplinks. Not thread-safe (ingest is single-tasked); LRU-bounded."""

    def __init__(self, max_entries: int = 512):
        self._by_name: "OrderedDict[str, int]" = OrderedDict()
        # Conflicting observations awaiting corroboration: name -> (hash, packet id).
        self._pending: "OrderedDict[str, Tuple[int, Optional[int]]]" = OrderedDict()
        # Names whose hash was just learned/re-keyed; drained by ingest so
        # storage can merge that name's bucket into the hash. Seeding stays
        # silent — seeded names were healed when first learned.
        self._learn_events: List[Tuple[str, int]] = []
        self._max_entries = max_entries

    def seed(self, mapping: Dict[str, int]) -> int:
        """Pre-load name -> hash pairs (e.g. chat_channels at startup); returns
        count. Seeded entries need the same corroboration to change as learned."""
        loaded = 0
        for name, value in mapping.items():
            if not name or name == PKI_CHANNEL:
                continue
            if not isinstance(value, int) or not 0 <= value <= 255:
                continue
            self._by_name[name] = value
            self._by_name.move_to_end(name)
            loaded += 1
        while len(self._by_name) > self._max_entries:
            self._by_name.popitem(last=False)
        if loaded:
            logger.info("Channel resolver seeded with %d wire-confirmed name(s)", loaded)
        return loaded

    def observe(
        self,
        channel_name: Optional[str],
        channel_hash_value: int,
        packet_id: Optional[int] = None,
    ) -> None:
        """Record the true hash for a name, seen on an encrypted uplink. Changing
        an established mapping needs two agreeing sightings from distinct packets."""
        if not channel_name or channel_name == PKI_CHANNEL:
            return
        if not 0 <= channel_hash_value <= 255:
            return

        known = self._by_name.get(channel_name)
        if known is not None and known != channel_hash_value:
            pending = self._pending.get(channel_name)
            same_proposal = pending is not None and pending[0] == channel_hash_value
            # None packet ids can't prove distinctness; treat as distinct for id-less callers.
            distinct_packet = (
                same_proposal
                and (pending[1] is None or packet_id is None or pending[1] != packet_id)
            )
            if not distinct_packet:
                if not same_proposal:
                    self._pending[channel_name] = (channel_hash_value, packet_id)
                    self._pending.move_to_end(channel_name)
                    while len(self._pending) > self._max_entries:
                        self._pending.popitem(last=False)
                logger.info(
                    "Channel %r reported hash %d (packet %s), holding at %d pending corroboration",
                    channel_name, channel_hash_value, packet_id, known,
                )
                return
            logger.info(
                "Channel %r changed hash %d -> %d (corroborated by distinct packets, latest %s)",
                channel_name, known, channel_hash_value, packet_id,
            )

        self._pending.pop(channel_name, None)
        # New learn or corroborated re-key, never a reaffirmation. Index-range
        # hashes emit nothing: resolve() keeps those names at their name bucket,
        # so there is no bucket to merge.
        if known != channel_hash_value and channel_hash_value > MAX_CHANNEL_INDEX:
            self._learn_events.append((channel_name, channel_hash_value))
            del self._learn_events[:-self._max_entries]
        self._by_name[channel_name] = channel_hash_value
        self._by_name.move_to_end(channel_name)
        while len(self._by_name) > self._max_entries:
            self._by_name.popitem(last=False)

    def drain_learn_events(self) -> List[Tuple[str, int]]:
        """(name, hash) pairs learned since the last drain; clears the queue."""
        events, self._learn_events = self._learn_events, []
        return events

    def requeue_learn_event(self, channel_name: str, channel_hash_value: int) -> None:
        """Put a drained event back after its merge failed. Reaffirmations never
        re-emit, so without this one failed merge strands the name bucket for good."""
        pair = (channel_name, channel_hash_value)
        if pair not in self._learn_events:
            self._learn_events.append(pair)
            del self._learn_events[:-self._max_entries]

    def lookup(self, channel_name: str) -> Optional[int]:
        """The learned hash for a name, or None. Read-only: no LRU promotion."""
        return self._by_name.get(channel_name)

    def resolve(
        self,
        raw_channel: int,
        is_encrypted: bool,
        channel_name: Optional[str],
        is_pki: bool = False,
        packet_id: Optional[int] = None,
    ) -> int:
        """Canonical channel bucket: encrypted uplinks teach and pass through;
        decoded slot indices remap to the learned hash, else to a name-keyed
        bucket — a decoded index carries no channel identity, the name does."""
        if is_pki or channel_name == PKI_CHANNEL:
            return raw_channel

        if is_encrypted:
            self.observe(channel_name, raw_channel, packet_id)
            if channel_name and 0 <= raw_channel <= MAX_CHANNEL_INDEX:
                learned = self._by_name.get(channel_name)
                if learned is not None and learned > MAX_CHANNEL_INDEX:
                    # Flap copy: index-range value for a name with an established
                    # hash — file with the channel; observe() still lets a re-key in.
                    logger.debug(
                        "Encrypted copy of %r claims channel %d; filing at learned %d",
                        channel_name, raw_channel, learned,
                    )
                    return learned
                # A real hash inside the index range (e.g. 'ares' -> 7) is
                # indistinguishable from a slot index and can't carry a name in
                # storage, so the named channel lives at its name bucket instead.
                return name_bucket_id(channel_name)
            return raw_channel

        if not channel_name:
            return raw_channel

        if not 0 <= raw_channel <= MAX_CHANNEL_INDEX:
            # Decoded packets should carry an index; anything else, trust the wire.
            logger.debug(
                "Decoded packet on %r has channel=%d, outside index range — keeping raw",
                channel_name, raw_channel,
            )
            return raw_channel

        learned = self._by_name.get(channel_name)
        if learned is None or learned <= MAX_CHANNEL_INDEX:
            bucket = name_bucket_id(channel_name)
            logger.debug(
                "No usable hash for channel %r — filing raw index %d at name bucket %d",
                channel_name, raw_channel, bucket,
            )
            return bucket

        self._by_name.move_to_end(channel_name)
        return learned
