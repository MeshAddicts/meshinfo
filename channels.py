#!/usr/bin/env python3
"""Meshtastic channel identity resolution: ``MeshPacket.channel`` is the 8-bit
(name, PSK) hash on encrypted uplinks but a gateway-local slot index (0-7) on
decoded ones; ChannelResolver learns name -> hash off the wire to remap indices."""

import logging
from collections import OrderedDict
from functools import reduce
from operator import xor
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# Firmware MAX_NUM_CHANNELS is 8, so a slot index is always 0-7.
MAX_CHANNEL_INDEX = 7

# Pseudo-channel gateways stamp on PKI DMs; no real channel behind it to resolve.
PKI_CHANNEL = "PKI"


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
        self._by_name[channel_name] = channel_hash_value
        self._by_name.move_to_end(channel_name)
        while len(self._by_name) > self._max_entries:
            self._by_name.popitem(last=False)

    def resolve(
        self,
        raw_channel: int,
        is_encrypted: bool,
        channel_name: Optional[str],
        is_pki: bool = False,
        packet_id: Optional[int] = None,
    ) -> int:
        """Canonical channel bucket: encrypted uplinks teach and pass through;
        decoded slot indices remap to the learned hash, else raw_channel."""
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
        if learned is None:
            logger.debug(
                "No hash learned for channel %r yet — keeping raw index %d",
                channel_name, raw_channel,
            )
            return raw_channel

        self._by_name.move_to_end(channel_name)
        return learned
