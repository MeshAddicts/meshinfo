"""
MeshBridge cog — live mesh-to-Discord message bridge.

Consumes events from DataStore.discord_event_queue, aggregates gateway
reports for the same packet over a configurable window (default 5s), then
posts or edits a Discord embed via webhook. The packet stays editable for
edit_window_seconds (default 900) so straggler gateway copies — measured up
to ~14 min late — update the posted embed instead of re-posting it (#585).
Each mesh node appears as a unique "sender" with its own name and avatar.
"""

import asyncio
import logging
import re
import time
from typing import Optional

import discord
from discord.ext import commands, tasks

from bot.embeds import build_text_embed, build_position_embed, build_gateway_detail_embed
from channels import normalize_wire_name
from data_store import DataStore

logger = logging.getLogger(__name__)

WEBHOOK_NAME = "MeshInfo Bridge"

WEBHOOK_USERNAME_LIMIT = 80  # Discord: 1-80 chars, some substrings rejected
MESSAGE_CONTENT_LIMIT = 2000


def _sanitize_webhook_username(name: str) -> str:
    """Keep a node-derived name valid as a webhook username."""
    name = re.sub(r"(?i)clyde", "clyd3", name)
    name = re.sub(r"(?i)discord", "disc0rd", name)
    name = name.strip() or "Mesh Node"
    if len(name) > WEBHOOK_USERNAME_LIMIT:
        name = name[: WEBHOOK_USERNAME_LIMIT - 1] + "…"
    return name


def _split_channel_map(raw: dict) -> tuple[dict, dict]:
    """Split a bridge channel map into (bucket-id keys, name keys).

    All-digit keys are channel bucket ids (hashes or name-bucket ids); anything
    else is a wire channel name, matched case-sensitively after the same
    normalization stored channel_name gets. A channel whose *name* is all
    digits must be mapped by its bucket id.
    """
    by_id: dict[str, str] = {}
    by_name: dict[str, str] = {}
    for key, value in (raw or {}).items():
        k = str(key)
        if k.isascii() and k.isdigit():  # bucket ids are str(int); "٣١" is a name
            by_id[k] = value
        else:
            norm = normalize_wire_name(k)
            if norm:
                by_name[norm] = value
    return by_id, by_name


def _chunk_mentions(user_ids: list, limit: int = MESSAGE_CONTENT_LIMIT - 100) -> list[str]:
    """Join mention tokens into content-sized chunks, never splitting a token."""
    chunks, current = [], ""
    for uid in user_ids:
        token = f"<@{uid}>"
        joined = f"{current} {token}" if current else token
        if len(joined) > limit and current:
            chunks.append(current)
            current = token
        else:
            current = joined
    if current:
        chunks.append(current)
    return chunks

# Module-level cache for gateway data (packet_id -> {msg, gateways, nodes})
# Used by the ViewGateways button to retrieve data after the embed is posted
_gateway_cache: dict[str, dict] = {}
_GATEWAY_CACHE_MAX = 200


class _ViewGatewaysButton(
    discord.ui.DynamicItem[discord.ui.Button], template=r"viewgw:(?P<pid>.+)"
):
    """Button that shows the full gateway breakdown. A DynamicItem so clicks
    still resolve after a bot restart (the cache may be gone; that degrades
    to the "expired" reply)."""

    def __init__(self, packet_id: str):
        super().__init__(discord.ui.Button(
            style=discord.ButtonStyle.secondary,
            label="View All Gateways",
            custom_id=f"viewgw:{packet_id}",
        ))
        self.packet_id = packet_id

    @classmethod
    async def from_custom_id(cls, interaction, item, match):
        return cls(match["pid"])

    async def callback(self, interaction: discord.Interaction):
        data = _gateway_cache.get(self.packet_id)
        if not data:
            await interaction.response.send_message(
                "Gateway data is no longer available (expired).", ephemeral=True,
            )
            return

        embeds = build_gateway_detail_embed(
            msg=data["msg"],
            nodes=data["nodes"],
            base_url=data["base_url"],
            gateway_entries=data["gateways"],
        )
        if embeds:
            await interaction.response.send_message(embeds=embeds, ephemeral=True)
        else:
            await interaction.response.send_message("No gateway data available.", ephemeral=True)


class _ViewGatewaysView(discord.ui.View):
    def __init__(self, packet_id: str):
        super().__init__(timeout=None)
        self.add_item(_ViewGatewaysButton(packet_id))


class _PendingPacket:
    """Tracks a packet that is accumulating gateway reports before posting."""

    __slots__ = (
        "event_type",
        "msg",
        "chat",
        "node_id",
        "gateways",
        "first_seen",
        "wall_first_seen",
        "last_post",
        "discord_message",
        "sent_via_webhook",
        "dirty",
    )

    MAX_GATEWAYS = 200  # keeps the embed and the detail view bounded

    def __init__(self, event_type: str, msg: dict, chat: Optional[dict] = None, node_id: Optional[str] = None):
        self.event_type = event_type
        self.msg = msg
        self.chat = chat
        self.node_id = node_id
        self.gateways: list[dict] = []
        self.first_seen: float = time.monotonic()
        self.wall_first_seen: float = time.time()
        self.last_post: float = 0.0
        self.discord_message: Optional[discord.Message] = None
        self.sent_via_webhook: bool = False
        self.dirty: bool = True

    def add_gateway(self, msg: dict):
        """Add a gateway report for this packet."""
        topic = msg.get("topic", "")
        # The decoder's normalized sender is the gateway; topic !suffix as fallback.
        gw_id = msg.get("sender") or ""
        if not gw_id:
            topic_parts = topic.split("/")
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
        if len(self.gateways) >= self.MAX_GATEWAYS:
            return
        self.gateways.append(entry)
        self.dirty = True


class MeshBridge(commands.Cog):
    """Bridges live mesh traffic into Discord channels."""

    def __init__(self, bot: commands.Bot, config: dict, data: DataStore):
        self.bot = bot
        self.config = config
        self.data = data

        bridge_cfg = config.get("integrations", {}).get("discord", {}).get("bridge", {})
        self.bridge_enabled = bridge_cfg.get("enabled", False)
        self.aggregate_seconds = bridge_cfg.get("aggregate_seconds", 5)
        # How long a posted packet keeps accepting straggler-gateway edits;
        # copies arrive up to ~14 min late, so shorter windows re-post (#585).
        self.edit_window_seconds = max(
            float(self.aggregate_seconds), float(bridge_cfg.get("edit_window_seconds", 900))
        )
        # Maps accept bucket ids ("31") or wire channel names ("MediumFast").
        self.channel_map: dict[str, str] = bridge_cfg.get("channels", {})
        self.position_channel_map: dict[str, str] = bridge_cfg.get("position_channels", {})
        self._chat_by_id, self._chat_by_name = _split_channel_map(self.channel_map)
        self._pos_by_id, self._pos_by_name = _split_channel_map(self.position_channel_map)

        # packet_key -> _PendingPacket, insertion-ordered (oldest first)
        self._pending: dict[str, _PendingPacket] = {}
        self._pending_max = 500

        # Webhook cache: discord_channel_id -> discord.Webhook
        self._webhooks: dict[int, discord.Webhook] = {}

        # Status alert channel (first text channel mapped, or configurable)
        self._alert_channel_id = bridge_cfg.get("alert_channel")
        # Track last known status per linked node: node_id -> bool (active)
        self._node_status: dict[str, bool] = {}

    @commands.Cog.listener()
    async def on_ready(self):
        # on_ready re-fires on session resume; starts must be idempotent.
        if self.bridge_enabled:
            logger.info("Discord: MeshBridge enabled — starting event consumer and flush loop")
            self.bot.add_dynamic_items(_ViewGatewaysButton)
            task = getattr(self, "_consume_task", None)
            if task is None or task.done():
                self._consume_task = asyncio.create_task(self._consume_events())
            if not self._flush_loop.is_running():
                self._flush_loop.start()
            if not self._status_check_loop.is_running():
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
        """Look up a node by ID via the storage-level LRU cache + PostgreSQL."""
        if not self.data.pg_storage:
            return None
        try:
            return await self.data.pg_storage.get_node_cached(node_id)
        except Exception:
            logger.debug("MeshBridge: DB lookup failed for node %s", node_id)
            return None

    async def _build_enriched_nodes(self, node_ids: list[str]) -> dict:
        """Build a nodes dict enriched with DB data for all referenced node IDs."""
        enriched = {}
        for nid in node_ids:
            node = await self._resolve_node(nid)
            if node:
                enriched[nid] = node
        return enriched

    @staticmethod
    def _map_lookup(by_id: dict, by_name: dict, bucket, channel_name) -> Optional[str]:
        """Discord channel id for a message: exact bucket-id key first (pins one
        crypto domain), then the wire name (follows the channel across re-keys
        and name buckets). None when unmapped."""
        hit = by_id.get(str(bucket if bucket is not None else "0"))
        if hit is not None:
            return hit
        name = normalize_wire_name(channel_name)
        return by_name.get(name) if name else None

    def _chat_discord_channel(self, bucket, channel_name) -> Optional[str]:
        return self._map_lookup(self._chat_by_id, self._chat_by_name, bucket, channel_name)

    def _position_discord_channel(self, bucket, channel_name) -> Optional[str]:
        hit = self._map_lookup(self._pos_by_id, self._pos_by_name, bucket, channel_name)
        if hit is not None:
            return hit
        return self._chat_discord_channel(bucket, channel_name)

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
            # Never-postable packets don't get a pending: with the long edit
            # window each entry holds a slot for edit_window_seconds, and dead
            # weight would evict packets that DID post (re-opening #585).
            if event_type == "text":
                chat = event.get("chat", {})
                if self._chat_discord_channel(chat.get("channel", "0"),
                                              chat.get("channel_name")) is None:
                    return
                pending = _PendingPacket("text", msg, chat=chat)
            elif event_type == "position":
                if self._position_discord_channel(msg.get("channel", "0"),
                                                  msg.get("channel_name")) is None:
                    return
                node_id = event.get("node_id", from_id)
                if not await self.data.pg_storage.is_node_tracked(node_id):
                    return
                pending = _PendingPacket("position", msg, node_id=node_id)
            else:
                return

            pending.add_gateway(msg)
            self._evict_for_room()
            self._pending[key] = pending

    def _evict_for_room(self):
        """Make room in _pending: posted-and-clean entries first (they only
        lose future straggler edits), oldest-first as the last resort."""
        while len(self._pending) >= self._pending_max:
            victim = next(
                (k for k, p in self._pending.items()
                 if p.discord_message is not None and not p.dirty),
                next(iter(self._pending)),
            )
            evicted = self._pending.pop(victim, None)
            if evicted is not None and time.monotonic() - evicted.first_seen < self.edit_window_seconds:
                logger.warning(
                    "MeshBridge: evicted packet %s before its edit window ended — "
                    "consider a larger pending capacity", victim,
                )

    @tasks.loop(seconds=1)
    async def _flush_loop(self):
        await self._flush_once()

    async def _flush_once(self, now: Optional[float] = None):
        """Post aged-past-aggregation packets; edit when late gateways landed."""
        now = time.monotonic() if now is None else now
        keys_to_remove = []

        for key, pending in list(self._pending.items()):
            age = now - pending.first_seen
            # Edits are throttled to one per aggregate window per packet.
            expiring = age > self.edit_window_seconds
            # The expiry pass waives the edit throttle so a straggler that
            # landed just after the last edit still reaches the embed.
            if (pending.dirty and age >= self.aggregate_seconds
                    and (expiring or now - pending.last_post >= self.aggregate_seconds)):
                # Cleared before the await: a gateway landing mid-post re-dirties
                # and gets picked up next tick instead of being clobbered.
                pending.dirty = False
                try:
                    await self._post_or_update(pending)
                except Exception:
                    pending.dirty = True
                    logger.exception("MeshBridge: Error posting packet %s", key)
                # Set either way: failed posts retry once per window, not per tick.
                pending.last_post = now

            if expiring:
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

        discord_channel_id = self._chat_discord_channel(
            chat.get("channel", "0"), chat.get("channel_name"))
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
        embed, was_truncated = build_text_embed(
            msg=msg,
            chat=chat,
            nodes=enriched_nodes,
            base_url=base_url,
            config=self.config,
            owner_id=owner_id,
            gateway_entries=pending.gateways,
            fallback_ts=pending.wall_first_seen,
        )

        # Only show "View All Gateways" button if gateway data was truncated
        view = None
        packet_id = msg.get("id")
        if packet_id and was_truncated:
            cache_key = str(packet_id)
            _gateway_cache[cache_key] = {
                "msg": msg,
                "gateways": list(pending.gateways),
                "nodes": dict(enriched_nodes),
                "base_url": base_url,
            }
            # Evict old entries
            while len(_gateway_cache) > _GATEWAY_CACHE_MAX:
                oldest = next(iter(_gateway_cache))
                _gateway_cache.pop(oldest, None)
            view = _ViewGatewaysView(cache_key)

        # Try webhook first (makes each node look like a unique sender)
        webhook = await self._get_webhook(channel)

        # A message is edited the way it was sent: editing a bot-sent message
        # through the webhook (or vice versa) 404s and would re-post instead.
        if pending.discord_message and pending.sent_via_webhook and webhook:
            # Edit existing webhook message — include view if truncation now requires it
            try:
                edit_kwargs = {"embed": embed}
                if view is not None:
                    edit_kwargs["view"] = view
                await webhook.edit_message(
                    pending.discord_message.id,
                    **edit_kwargs,
                )
                return
            except Exception:
                logger.debug("MeshBridge: Failed to edit webhook message, posting new")
                pending.discord_message = None

        if not pending.discord_message and webhook:
            try:
                send_kwargs = {
                    "embed": embed,
                    "username": sender_name,
                    "avatar_url": avatar_url,
                    "wait": True,
                }
                if view is not None:
                    send_kwargs["view"] = view
                sent = await webhook.send(**send_kwargs)
                pending.discord_message = sent
                pending.sent_via_webhook = True
                return
            except Exception:
                logger.exception("MeshBridge: Webhook send failed, falling back to bot message")

        # Fallback: edit/send as bot
        if pending.discord_message and not pending.sent_via_webhook:
            try:
                edit_kwargs = {"embed": embed}
                if view is not None:
                    edit_kwargs["view"] = view
                await pending.discord_message.edit(**edit_kwargs)
                return
            except Exception:
                pending.discord_message = None

        try:
            send_kwargs = {"embed": embed}
            if view is not None:
                send_kwargs["view"] = view
            sent = await channel.send(**send_kwargs)
            pending.discord_message = sent
            pending.sent_via_webhook = False
        except Exception:
            logger.exception("MeshBridge: Failed to send text message to channel %s", discord_channel_id)

    async def _post_position(self, pending: _PendingPacket):
        """Post or update a position embed for a tracked node."""
        msg = pending.msg
        node_id = pending.node_id or msg.get("from", "")

        # Only post for tracked nodes
        if not await self.data.pg_storage.is_node_tracked(node_id):
            return

        discord_channel_id = self._position_discord_channel(
            msg.get("channel", "0"), msg.get("channel_name"))
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
            fallback_ts=pending.wall_first_seen,
        )

        webhook = await self._get_webhook(channel)

        # Same routing as _post_text: edit the way it was sent.
        if pending.discord_message and pending.sent_via_webhook and webhook:
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
                pending.sent_via_webhook = True
                return
            except Exception:
                logger.exception("MeshBridge: Webhook send failed for position, falling back")

        # Fallback: edit/send as bot
        if pending.discord_message and not pending.sent_via_webhook:
            try:
                await pending.discord_message.edit(embed=embed)
                return
            except Exception:
                pending.discord_message = None

        try:
            sent = await channel.send(embed=embed)
            pending.discord_message = sent
            pending.sent_via_webhook = False
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
            links = await self.data.pg_storage.get_all_watched_nodes()
        except Exception:
            return

        if not links:
            return

        base_url = self.config.get("server", {}).get("base_url", "").rstrip("/")

        # Group watchers by node to avoid duplicate alerts
        node_watchers: dict[str, list[str]] = {}
        for link in links:
            nid = link["node_id"]
            uid = link["discord_user_id"]
            node_watchers.setdefault(nid, []).append(uid)

        for node_id, watcher_ids in node_watchers.items():
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

                # Message content caps at 2000 chars; chunk so no ping is lost.
                mention_chunks = _chunk_mentions(watcher_ids)

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

                embed.set_footer(text=f"Node: !{node_id}")

                try:
                    await channel.send(content=mention_chunks[0] if mention_chunks else None, embed=embed)
                    for extra in mention_chunks[1:]:
                        await channel.send(content=extra)
                except Exception:
                    logger.debug("MeshBridge: Failed to send status alert for %s", node_id)

    @_status_check_loop.before_loop
    async def _before_status_check(self):
        await self.bot.wait_until_ready()

    # ─── Helpers ─────────────────────────────────────────────────────

    @staticmethod
    def _get_display_name(node: Optional[dict], node_id: str) -> str:
        """Get a display name for a node, suitable for webhook username."""
        name = f"!{node_id}"
        if node:
            longname = node.get("longname", "")
            shortname = node.get("shortname", "")
            if longname and longname != "Unknown":
                name = f"{longname} [{shortname}]" if shortname and shortname != "UNK" else longname
            elif shortname and shortname != "UNK":
                name = shortname
        return _sanitize_webhook_username(name)
