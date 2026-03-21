"""
MeshBridge cog — live mesh-to-Discord message bridge.

Consumes events from MemoryDataStore.discord_event_queue, aggregates gateway
reports for the same packet over a configurable window (default 5s), then
posts or edits a Discord embed. This gives the "growing gateway list" UX
from RATM 2.0 without needing Redis.
"""

import asyncio
import logging
import time
from typing import Optional

import discord
from discord.ext import commands, tasks

from bot.embeds import build_text_embed, build_position_embed
from memory_data_store import MemoryDataStore

logger = logging.getLogger(__name__)


class _PendingPacket:
    """Tracks a packet that is accumulating gateway reports before posting."""

    __slots__ = (
        "event_type",
        "msg",
        "chat",
        "node_id",
        "gateways",
        "first_seen",
        "discord_message",
        "dirty",
    )

    def __init__(self, event_type: str, msg: dict, chat: Optional[dict] = None, node_id: Optional[str] = None):
        self.event_type = event_type
        self.msg = msg
        self.chat = chat
        self.node_id = node_id
        self.gateways: list[dict] = []
        self.first_seen: float = time.monotonic()
        self.discord_message: Optional[discord.Message] = None
        self.dirty: bool = True

    def add_gateway(self, msg: dict):
        """Add a gateway report for this packet."""
        topic = msg.get("topic", "")
        topic_parts = topic.split("/")
        gw_id = ""
        if topic_parts and topic_parts[-1].startswith("!"):
            gw_id = topic_parts[-1].replace("!", "")

        entry = {
            "gateway_id": gw_id,
            "rssi": msg.get("rssi"),
            "snr": msg.get("snr"),
            "hops_away": msg.get("hops_away"),
            "topic": topic,
        }

        # Deduplicate by gateway_id
        for existing in self.gateways:
            if existing["gateway_id"] == gw_id and gw_id:
                return
        self.gateways.append(entry)
        self.dirty = True


class MeshBridge(commands.Cog):
    """Bridges live mesh traffic into Discord channels."""

    def __init__(self, bot: commands.Bot, config: dict, data: MemoryDataStore):
        self.bot = bot
        self.config = config
        self.data = data

        bridge_cfg = config.get("integrations", {}).get("discord", {}).get("bridge", {})
        self.bridge_enabled = bridge_cfg.get("enabled", False)
        self.aggregate_seconds = bridge_cfg.get("aggregate_seconds", 5)
        self.channel_map: dict[str, str] = bridge_cfg.get("channels", {})
        self.position_channel_map: dict[str, str] = bridge_cfg.get("position_channels", {})

        # packet_key -> _PendingPacket
        self._pending: dict[str, _PendingPacket] = {}
        # Cache of recently sent Discord message IDs for reply threading
        # mesh_packet_id -> discord.Message
        self._reply_cache: dict[int, discord.Message] = {}
        self._reply_cache_max = 500

    @commands.Cog.listener()
    async def on_ready(self):
        if self.bridge_enabled:
            logger.info("Discord: MeshBridge enabled — starting event consumer and flush loop")
            self._consume_task = asyncio.create_task(self._consume_events())
            self._flush_loop.start()
        else:
            logger.info("Discord: MeshBridge disabled in config")

    def cog_unload(self):
        if hasattr(self, "_consume_task"):
            self._consume_task.cancel()
        if self._flush_loop.is_running():
            self._flush_loop.cancel()

    async def _consume_events(self):
        """Read events from the queue and aggregate into pending packets."""
        while True:
            try:
                event = await self.data.discord_event_queue.get()
                await self._handle_event(event)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("MeshBridge: Error consuming event")

    async def _handle_event(self, event: dict):
        """Process a single event from the MQTT pipeline."""
        event_type = event.get("type")
        msg = event.get("msg", {})

        packet_id = msg.get("id")
        from_id = msg.get("from", "")
        if not packet_id or not from_id:
            return

        key = f"{packet_id}:{from_id}"

        if key in self._pending:
            # Additional gateway for an already-seen packet
            self._pending[key].add_gateway(msg)
        else:
            if event_type == "text":
                chat = event.get("chat", {})
                pending = _PendingPacket("text", msg, chat=chat)
            elif event_type == "position":
                node_id = event.get("node_id", from_id)
                pending = _PendingPacket("position", msg, node_id=node_id)
            else:
                return

            pending.add_gateway(msg)
            self._pending[key] = pending

    @tasks.loop(seconds=1)
    async def _flush_loop(self):
        """Periodically flush pending packets that have aged past the aggregation window."""
        now = time.monotonic()
        keys_to_remove = []

        for key, pending in self._pending.items():
            age = now - pending.first_seen
            if age >= self.aggregate_seconds and pending.dirty:
                try:
                    await self._post_or_update(pending)
                    pending.dirty = False
                except Exception:
                    logger.exception("MeshBridge: Error posting packet %s", key)

            # Clean up old entries (keep for 60s for late gateways, then discard)
            if age > 60:
                keys_to_remove.append(key)

        for key in keys_to_remove:
            self._pending.pop(key, None)

    @_flush_loop.before_loop
    async def _before_flush_loop(self):
        await self.bot.wait_until_ready()

    async def _post_or_update(self, pending: _PendingPacket):
        """Post a new embed or edit an existing one with updated gateway info."""
        if pending.event_type == "text":
            await self._post_text(pending)
        elif pending.event_type == "position":
            await self._post_position(pending)

    async def _post_text(self, pending: _PendingPacket):
        """Post or update a text message embed."""
        chat = pending.chat or {}
        msg = pending.msg
        channel_hash = str(chat.get("channel", "0"))

        discord_channel_id = self.channel_map.get(channel_hash)
        if not discord_channel_id:
            return

        channel = self.bot.get_channel(int(discord_channel_id))
        if not channel:
            try:
                channel = await self.bot.fetch_channel(int(discord_channel_id))
            except Exception:
                logger.warning("MeshBridge: Cannot find Discord channel %s", discord_channel_id)
                return

        from_id = chat.get("from", msg.get("from", ""))

        # Check if node is banned
        if await self.data.pg_storage.is_node_banned(from_id):
            logger.debug("MeshBridge: Skipping banned node %s", from_id)
            return

        # Filter out test messages
        text = chat.get("text", "")
        if text.startswith("seq ") and text[4:].isdigit():
            return

        # Get node owner
        owner_id = await self.data.pg_storage.get_node_owner(from_id)

        base_url = self.config.get("server", {}).get("base_url", "")
        embed = build_text_embed(
            msg=msg,
            chat=chat,
            nodes=self.data.nodes,
            base_url=base_url,
            owner_id=owner_id,
            gateway_entries=pending.gateways,
        )

        # Reply threading: if this mesh message has a reply_id, find the Discord message
        reply_to = None
        reply_id = msg.get("decoded", {}).get("reply_id") if isinstance(msg.get("decoded"), dict) else None
        if reply_id and reply_id in self._reply_cache:
            reply_to = self._reply_cache[reply_id]

        if pending.discord_message:
            # Edit existing message with updated gateway info
            try:
                await pending.discord_message.edit(embed=embed)
            except Exception:
                logger.warning("MeshBridge: Failed to edit message, posting new")
                pending.discord_message = None

        if not pending.discord_message:
            kwargs = {"embed": embed}
            if reply_to:
                kwargs["reference"] = reply_to
            try:
                sent = await channel.send(**kwargs)
                pending.discord_message = sent
                # Cache for reply threading
                packet_id = msg.get("id")
                if packet_id:
                    self._reply_cache[packet_id] = sent
                    # Evict old entries
                    if len(self._reply_cache) > self._reply_cache_max:
                        oldest_key = next(iter(self._reply_cache))
                        self._reply_cache.pop(oldest_key, None)
            except Exception:
                logger.exception("MeshBridge: Failed to send text message to channel %s", discord_channel_id)

    async def _post_position(self, pending: _PendingPacket):
        """Post or update a position embed for a tracked node."""
        msg = pending.msg
        node_id = pending.node_id or msg.get("from", "")

        # Only post for tracked nodes
        if not await self.data.pg_storage.is_node_tracked(node_id):
            return

        channel_hash = str(msg.get("channel", "0"))
        discord_channel_id = self.position_channel_map.get(channel_hash)
        if not discord_channel_id:
            # Fall back to text channel map
            discord_channel_id = self.channel_map.get(channel_hash)
        if not discord_channel_id:
            return

        channel = self.bot.get_channel(int(discord_channel_id))
        if not channel:
            try:
                channel = await self.bot.fetch_channel(int(discord_channel_id))
            except Exception:
                logger.warning("MeshBridge: Cannot find Discord channel %s", discord_channel_id)
                return

        # Check ban
        if await self.data.pg_storage.is_node_banned(node_id):
            return

        track_type = await self.data.pg_storage.get_tracker_type(node_id) or "tracker"
        owner_id = await self.data.pg_storage.get_node_owner(node_id)

        base_url = self.config.get("server", {}).get("base_url", "")
        embed = build_position_embed(
            msg=msg,
            node_id=node_id,
            nodes=self.data.nodes,
            base_url=base_url,
            track_type=track_type,
            owner_id=owner_id,
            gateway_entries=pending.gateways,
        )

        if pending.discord_message:
            try:
                await pending.discord_message.edit(embed=embed)
            except Exception:
                pending.discord_message = None

        if not pending.discord_message:
            try:
                sent = await channel.send(embed=embed)
                pending.discord_message = sent
            except Exception:
                logger.exception("MeshBridge: Failed to send position to channel %s", discord_channel_id)
