"""
MeshBridge cog — live mesh-to-Discord message bridge.

Consumes events from MemoryDataStore.discord_event_queue, aggregates gateway
reports for the same packet over a configurable window (default 5s), then
posts or edits a Discord embed via webhook. Each mesh node appears as a
unique "sender" with its own name and avatar in Discord.
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

WEBHOOK_NAME = "MeshInfo Bridge"


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

        # Webhook cache: discord_channel_id -> discord.Webhook
        self._webhooks: dict[int, discord.Webhook] = {}

        # Node info cache from DB: node_id -> node dict (avoids repeated queries)
        self._node_cache: dict[str, Optional[dict]] = {}
        self._node_cache_max = 1000

        # Status alert channel (first text channel mapped, or configurable)
        self._alert_channel_id = bridge_cfg.get("alert_channel")
        # Track last known status per linked node: node_id -> bool (active)
        self._node_status: dict[str, bool] = {}

    @commands.Cog.listener()
    async def on_ready(self):
        if self.bridge_enabled:
            logger.info("Discord: MeshBridge enabled — starting event consumer and flush loop")
            self._consume_task = asyncio.create_task(self._consume_events())
            self._flush_loop.start()
            self._status_check_loop.start()
        else:
            logger.info("Discord: MeshBridge disabled in config")

    def cog_unload(self):
        if hasattr(self, "_consume_task"):
            self._consume_task.cancel()
        if self._flush_loop.is_running():
            self._flush_loop.cancel()
        if self._status_check_loop.is_running():
            self._status_check_loop.cancel()

    # ─── Node name resolution ────────────────────────────────────────

    async def _resolve_node(self, node_id: str) -> Optional[dict]:
        """Look up a node by ID, checking in-memory first then PostgreSQL."""
        # In-memory (live data from this session)
        node = self.data.nodes.get(node_id)
        if node and node.get("longname", "Unknown") != "Unknown":
            return node

        # Local cache (avoids repeated DB hits for the same node)
        if node_id in self._node_cache:
            return self._node_cache[node_id]

        # PostgreSQL
        if self.data.pg_storage:
            try:
                db_node = await self.data.pg_storage.query_node_by_id(node_id)
                if db_node:
                    self._node_cache[node_id] = db_node
                    # Evict old cache entries
                    if len(self._node_cache) > self._node_cache_max:
                        oldest = next(iter(self._node_cache))
                        self._node_cache.pop(oldest, None)
                    return db_node
            except Exception:
                logger.debug("MeshBridge: DB lookup failed for node %s", node_id)

        # Return whatever we have from memory (might be a skeleton)
        self._node_cache[node_id] = node
        return node

    async def _build_enriched_nodes(self, node_ids: list[str]) -> dict:
        """Build a nodes dict enriched with DB data for all referenced node IDs."""
        enriched = {}
        for nid in node_ids:
            node = await self._resolve_node(nid)
            if node:
                enriched[nid] = node
        return enriched

    # ─── Webhook management ──────────────────────────────────────────

    _WEBHOOK_UNAVAILABLE = object()  # sentinel for channels where webhooks are forbidden

    async def _get_webhook(self, channel: discord.TextChannel) -> Optional[discord.Webhook]:
        """Get or create a webhook for the given channel."""
        cached = self._webhooks.get(channel.id)
        if cached is self._WEBHOOK_UNAVAILABLE:
            return None  # already know webhooks are forbidden here
        if cached is not None:
            return cached

        try:
            # Look for an existing MeshInfo webhook
            webhooks = await channel.webhooks()
            for wh in webhooks:
                if wh.name == WEBHOOK_NAME:
                    self._webhooks[channel.id] = wh
                    return wh

            # Create one
            wh = await channel.create_webhook(name=WEBHOOK_NAME)
            self._webhooks[channel.id] = wh
            return wh
        except discord.Forbidden:
            logger.warning("MeshBridge: No permission to manage webhooks in #%s — falling back to bot messages", channel.name)
            self._webhooks[channel.id] = self._WEBHOOK_UNAVAILABLE
            return None
        except Exception:
            logger.exception("MeshBridge: Failed to get/create webhook for #%s", channel.name)
            return None

    # ─── Event consumption ───────────────────────────────────────────

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

        for key, pending in list(self._pending.items()):
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

        # Resolve all referenced node IDs from DB
        all_node_ids = [from_id]
        for gw in pending.gateways:
            gw_id = gw.get("gateway_id", "")
            if gw_id:
                all_node_ids.append(gw_id)
        enriched_nodes = await self._build_enriched_nodes(all_node_ids)

        # Get sender info for webhook
        sender_node = enriched_nodes.get(from_id)
        sender_name = self._get_display_name(sender_node, from_id)
        avatar_url = f"https://api.dicebear.com/9.x/bottts-neutral/png?seed={from_id}"

        # Get node owner
        owner_id = await self.data.pg_storage.get_node_owner(from_id)

        base_url = self.config.get("server", {}).get("base_url", "")
        embed = build_text_embed(
            msg=msg,
            chat=chat,
            nodes=enriched_nodes,
            base_url=base_url,
            config=self.config,
            owner_id=owner_id,
            gateway_entries=pending.gateways,
        )

        # Try webhook first (makes each node look like a unique sender)
        webhook = await self._get_webhook(channel)

        if pending.discord_message and webhook:
            # Edit existing webhook message
            try:
                await webhook.edit_message(
                    pending.discord_message.id,
                    embed=embed,
                )
                return
            except Exception:
                logger.debug("MeshBridge: Failed to edit webhook message, posting new")
                pending.discord_message = None

        if not pending.discord_message and webhook:
            try:
                sent = await webhook.send(
                    embed=embed,
                    username=sender_name,
                    avatar_url=avatar_url,
                    wait=True,
                )
                pending.discord_message = sent
                packet_id = msg.get("id")
                if packet_id:
                    self._reply_cache[packet_id] = sent
                    if len(self._reply_cache) > self._reply_cache_max:
                        oldest_key = next(iter(self._reply_cache))
                        self._reply_cache.pop(oldest_key, None)
                return
            except Exception:
                logger.exception("MeshBridge: Webhook send failed, falling back to bot message")

        # Fallback: send as bot
        if pending.discord_message:
            try:
                await pending.discord_message.edit(embed=embed)
                return
            except Exception:
                pending.discord_message = None

        try:
            sent = await channel.send(embed=embed)
            pending.discord_message = sent
            packet_id = msg.get("id")
            if packet_id:
                self._reply_cache[packet_id] = sent
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

        if await self.data.pg_storage.is_node_banned(node_id):
            return

        # Resolve node IDs from DB
        all_node_ids = [node_id]
        for gw in pending.gateways:
            gw_id = gw.get("gateway_id", "")
            if gw_id:
                all_node_ids.append(gw_id)
        enriched_nodes = await self._build_enriched_nodes(all_node_ids)

        sender_node = enriched_nodes.get(node_id)
        sender_name = self._get_display_name(sender_node, node_id)
        avatar_url = f"https://api.dicebear.com/9.x/bottts-neutral/png?seed={node_id}"

        track_type = await self.data.pg_storage.get_tracker_type(node_id) or "tracker"
        owner_id = await self.data.pg_storage.get_node_owner(node_id)

        base_url = self.config.get("server", {}).get("base_url", "")
        embed = build_position_embed(
            msg=msg,
            node_id=node_id,
            nodes=enriched_nodes,
            base_url=base_url,
            config=self.config,
            track_type=track_type,
            owner_id=owner_id,
            gateway_entries=pending.gateways,
        )

        webhook = await self._get_webhook(channel)

        if pending.discord_message and webhook:
            try:
                await webhook.edit_message(pending.discord_message.id, embed=embed)
                return
            except Exception:
                pending.discord_message = None

        if not pending.discord_message and webhook:
            try:
                sent = await webhook.send(
                    embed=embed,
                    username=sender_name,
                    avatar_url=avatar_url,
                    wait=True,
                )
                pending.discord_message = sent
                return
            except Exception:
                logger.exception("MeshBridge: Webhook send failed for position, falling back")

        # Fallback
        if pending.discord_message:
            try:
                await pending.discord_message.edit(embed=embed)
                return
            except Exception:
                pending.discord_message = None

        try:
            sent = await channel.send(embed=embed)
            pending.discord_message = sent
        except Exception:
            logger.exception("MeshBridge: Failed to send position to channel %s", discord_channel_id)

    # ─── Node status alerts ────────────────────────────────────────

    @tasks.loop(minutes=5)
    async def _status_check_loop(self):
        """Check linked nodes for online/offline status changes."""
        if not self.data.pg_storage:
            return

        # Determine alert channel
        alert_channel_id = self._alert_channel_id
        if not alert_channel_id:
            # Fall back to first mapped text channel
            if self.channel_map:
                alert_channel_id = next(iter(self.channel_map.values()))
        if not alert_channel_id:
            return

        channel = self.bot.get_channel(int(alert_channel_id))
        if not channel:
            try:
                channel = await self.bot.fetch_channel(int(alert_channel_id))
            except Exception:
                return

        try:
            links = await self.data.pg_storage.get_all_linked_nodes()
        except Exception:
            return

        if not links:
            return

        base_url = self.config.get("server", {}).get("base_url", "").rstrip("/")

        for link in links:
            node_id = link["node_id"]
            discord_user_id = link["discord_user_id"]

            # Get current status from DB
            node = await self._resolve_node(node_id)
            if not node:
                continue

            current_active = bool(node.get("active", False))
            prev_active = self._node_status.get(node_id)

            # Store current status
            self._node_status[node_id] = current_active

            # Skip on first run (no previous state to compare)
            if prev_active is None:
                continue

            # Status changed
            if current_active != prev_active:
                display_name = self._get_display_name(node, node_id)
                node_url = f"{base_url}/nodes?node={node_id}" if base_url else ""

                if current_active:
                    embed = discord.Embed(
                        description=f"**{display_name}** is now **online**",
                        color=discord.Color.from_rgb(87, 187, 138),
                    )
                else:
                    embed = discord.Embed(
                        description=f"**{display_name}** has gone **offline**",
                        color=discord.Color.from_rgb(194, 108, 108),
                    )

                if node_url:
                    embed.description = f"[{display_name}]({node_url}) {'is now **online**' if current_active else 'has gone **offline**'}"

                embed.set_footer(text=f"Node: !{node_id} | Owner: <@{discord_user_id}>")

                try:
                    await channel.send(embed=embed)
                except Exception:
                    logger.debug("MeshBridge: Failed to send status alert for %s", node_id)

    @_status_check_loop.before_loop
    async def _before_status_check(self):
        await self.bot.wait_until_ready()

    # ─── Helpers ─────────────────────────────────────────────────────

    @staticmethod
    def _get_display_name(node: Optional[dict], node_id: str) -> str:
        """Get a display name for a node, suitable for webhook username."""
        if node:
            longname = node.get("longname", "")
            shortname = node.get("shortname", "")
            if longname and longname != "Unknown":
                if shortname and shortname != "UNK":
                    return f"{longname} [{shortname}]"
                return longname
            if shortname and shortname != "UNK":
                return shortname
        return f"!{node_id}"
