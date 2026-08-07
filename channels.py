#!/usr/bin/env python3
"""Meshtastic channel identity resolution.

`MeshPacket.channel` carries two different kinds of number, depending on how the
uplinking gateway was configured:

  * ``mqtt.encryption_enabled = true`` (firmware default) — the gateway
    republishes the *encrypted* packet, whose ``channel`` field holds the 8-bit
    channel hash, ``xorHash(name) ^ xorHash(psk)``.
  * ``mqtt.encryption_enabled = false`` — the gateway republishes the packet it
    already decoded, and firmware overwrites the field during decrypt
    (``p->channel = chIndex``), so it holds that gateway's *local slot index*
    (0-7).

Storing both verbatim in one column splits a single logical channel across
buckets, and which bucket a message lands in depends on which gateway's copy won
the ingest race. Indices are resolved back to the hash using the channel name,
which the gateway supplies either way — ``ServiceEnvelope.channel_id``, mirrored
in the MQTT topic as ``msh/<region>/2/e/<name>/<gateway>``.

Computing the hash needs the channel's PSK, which we do not have for a decoded
packet — no key was involved on our side. So instead of guessing a key, the
resolver *learns* the mapping: an encrypted uplink carries both the name and the
true hash, so observing those builds a name -> hash table that decoded uplinks
are then looked up in. Encrypted copies dominate real traffic, so the table
fills quickly. A name never seen encrypted resolves to its raw value rather than
a fabricated one — a bucket that is merely unmerged is recoverable, whereas a
bucket invented from the wrong PSK is indistinguishable from a real hash.

The table is seeded at startup from ``chat_channels`` (whose names were healed
off the wire by this same pipeline), so a restart does not reopen the learning
window — without that, a rare channel's first post-restart decoded packet lands
on a raw index and ``ON CONFLICT DO NOTHING`` makes the misfile permanent.

The hash is a decode hint, not an identity: it is 8 bits, only 128 values are
reachable for ASCII names on a given PSK, and distinct names collide. Resolution
makes buckets *consistent*, not unique.
"""

import logging
from collections import OrderedDict
from functools import reduce
from operator import xor
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# Firmware MAX_NUM_CHANNELS is 8, so a slot index is always 0-7.
MAX_CHANNEL_INDEX = 7

# Gateways label PKI-encrypted DMs with this pseudo-channel. Firmware also runs
# `p->channel = chIndex` after a PKC decrypt, so a decoded PKI copy looks like an
# index — but there is no real channel behind it to resolve to.
PKI_CHANNEL = "PKI"


def xor_hash(data: bytes) -> int:
    """Firmware's xorHash: a byte-wise XOR fold."""
    return reduce(xor, data, 0)


def channel_hash(name: str, psk: bytes) -> int:
    """Firmware's Channels::generateHash — xorHash(name) ^ xorHash(psk).

    `name` is the *effective* channel name: firmware substitutes the modem-preset
    display string ("LongFast", ...) when the name field is blank, so an
    unconfigured node hashes "LongFast" and never the empty string.

    Not used for live resolution (see the module docstring) — kept for offline
    work such as re-resolving historical rows, where the PSK is known.
    """
    return xor_hash(name.encode("utf-8")) ^ xor_hash(psk)


def name_from_topic(topic: str) -> Optional[str]:
    """Channel name from an `.../2/e/<name>/<gateway>` topic, else None.

    Only a fallback: `ServiceEnvelope.channel_id` is the primary source and is
    set on virtually all real traffic, including map reports.
    """
    if not topic:
        return None
    parts = topic.split("/")
    for i in range(len(parts) - 2):
        if parts[i] == "2" and parts[i + 1] == "e":
            return parts[i + 2] or None
    return None


class ChannelResolver:
    """Maps gateway slot indices back to channel hashes, learning as it goes.

    Not thread-safe; ingest is single-tasked. Bounded to `max_entries` on an LRU
    policy so a flood of junk names cannot grow it without limit.
    """

    def __init__(self, max_entries: int = 512):
        self._by_name: "OrderedDict[str, int]" = OrderedDict()
        # Conflicting observations awaiting corroboration:
        # name -> (proposed hash, packet id it arrived on).
        self._pending: "OrderedDict[str, Tuple[int, Optional[int]]]" = OrderedDict()
        self._max_entries = max_entries

    def seed(self, mapping: Dict[str, int]) -> int:
        """Pre-load learned name -> hash pairs, e.g. from chat_channels at
        startup. Seeded entries count as established: changing one needs the
        same corroboration as a live-learned entry. Returns how many loaded."""
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
        """Record the true hash for a name, as seen on an encrypted uplink.

        A first sighting is taken on trust, but *changing* an established
        mapping needs two agreeing sightings from DIFFERENT packets. Both halves
        are load-bearing, from production incidents:

          * A gateway intermittently uplinks encrypted copies carrying channel 0
            on a `MediumFast` topic; under last-writer-wins that re-taught
            `MediumFast -> 0` for ~84 ms at a time.
          * The same gateway publishes each packet twice ~330 ms apart, so
            "two consecutive sightings" alone was satisfied by one flapped
            packet's two copies — the change was wrongly confirmed.

        A genuinely re-keyed channel still migrates: its new hash arrives on
        every subsequent packet, so the second distinct packet confirms it.
        """
        if not channel_name or channel_name == PKI_CHANNEL:
            return
        if not 0 <= channel_hash_value <= 255:
            return

        known = self._by_name.get(channel_name)
        if known is not None and known != channel_hash_value:
            pending = self._pending.get(channel_name)
            same_proposal = pending is not None and pending[0] == channel_hash_value
            # None packet ids can't prove distinctness; treat them as distinct
            # to preserve plain two-sighting semantics for id-less callers.
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
        """Canonical channel bucket for a packet.

        Encrypted uplinks carry the hash and normally pass through, teaching the
        resolver as they go. One exception, seen live: a flapping gateway emits
        encrypted copies whose channel byte is an index-range value (0-7) for a
        channel whose established hash is not — those file at the learned hash,
        while observe() keeps running so a genuine re-key into 0-7 can still
        corroborate its way in and then pass through raw.

        Decoded uplinks carry a gateway-local slot index and are remapped to the
        learned hash for their channel. `raw_channel` comes back whenever the
        reading cannot be trusted or the name is unknown.
        """
        if is_pki or channel_name == PKI_CHANNEL:
            return raw_channel

        if is_encrypted:
            self.observe(channel_name, raw_channel, packet_id)
            if channel_name and 0 <= raw_channel <= MAX_CHANNEL_INDEX:
                learned = self._by_name.get(channel_name)
                if learned is not None and learned > MAX_CHANNEL_INDEX:
                    # Flap copy: the wire claims an index-range value while this
                    # name's established hash is a real one. File with the
                    # channel, not the glitch. (observe() above already recorded
                    # the claim as pending, so a true re-key still lands.)
                    logger.debug(
                        "Encrypted copy of %r claims channel %d; filing at learned %d",
                        channel_name, raw_channel, learned,
                    )
                    return learned
            return raw_channel

        if not channel_name:
            return raw_channel

        if not 0 <= raw_channel <= MAX_CHANNEL_INDEX:
            # A decoded packet should always carry an index; anything else means
            # the gateway is not doing what we think. Trust the wire.
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
