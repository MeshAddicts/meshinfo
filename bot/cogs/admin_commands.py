"""
Admin and user slash commands for the Discord bridge.

User commands:
  /linknode     — Associate a mesh node ID with your Discord account
  /unlinknode   — Remove association
  /mylinkednodes — List your linked nodes

Moderator/Admin commands:
  /addtracker    — Enable position forwarding for a node
  /removetracker — Disable position forwarding
  /addballoon    — Mark node as balloon (position forwarding)
  /removeballoon — Remove balloon marking
  /bannode       — Suppress all messages from a node
  /unbannode     — Remove ban
"""

import asyncio
import logging
import re
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

import utils
from memory_data_store import MemoryDataStore

logger = logging.getLogger(__name__)

# Validate hex node IDs (8 hex chars, with or without ! prefix)
_NODE_ID_RE = re.compile(r"^!?([0-9a-fA-F]{1,8})$")


def _normalize_node_id(raw: str) -> str | None:
    """Normalize a node ID to lowercase 8-char hex, or None if invalid."""
    m = _NODE_ID_RE.match(raw.strip())
    if not m:
        return None
    return m.group(1).lower().zfill(8)


def _is_mod(interaction: discord.Interaction) -> bool:
    """Check if the user has manage_messages permission (mod-level)."""
    if not interaction.guild:
        return False
    perms = interaction.channel.permissions_for(interaction.user)
    return perms.manage_messages or perms.administrator


class _UnlinkButton(discord.ui.Button):
    """A button that unlinks a specific node when clicked."""

    def __init__(self, pg_storage, node_id: str, label: str):
        super().__init__(
            style=discord.ButtonStyle.danger,
            label=f"Unlink {label}",
            custom_id=f"unlink:{node_id}",
        )
        self.pg_storage = pg_storage
        self.node_id = node_id

    async def callback(self, interaction: discord.Interaction):
        ok = await self.pg_storage.unlink_node(self.node_id, str(interaction.user.id))
        if ok:
            await interaction.response.send_message(
                f"Unlinked node `!{self.node_id}`.", ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                f"Node `!{self.node_id}` was not linked to your account.", ephemeral=True,
            )


class _UnlinkView(discord.ui.View):
    """A view containing unlink buttons for each linked node."""

    def __init__(self, pg_storage, node_ids: list[str]):
        super().__init__(timeout=120)
        # Discord allows max 25 components, 5 per row
        for nid in node_ids[:25]:
            short_label = nid[:8]
            self.add_item(_UnlinkButton(pg_storage, nid, short_label))


class _UnwatchButton(discord.ui.Button):
    """A button that unwatches a specific node."""

    def __init__(self, pg_storage, node_id: str, label: str, discord_user_id: str):
        super().__init__(
            style=discord.ButtonStyle.danger,
            label=f"Unwatch {label}",
            custom_id=f"unwatch:{node_id}",
        )
        self.pg_storage = pg_storage
        self.node_id = node_id
        self.discord_user_id = discord_user_id

    async def callback(self, interaction: discord.Interaction):
        ok = await self.pg_storage.unwatch_node(self.node_id, str(interaction.user.id))
        if ok:
            await interaction.response.send_message(
                f"Stopped watching node `!{self.node_id}`.", ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                f"Node `!{self.node_id}` was not being watched.", ephemeral=True,
            )


class _UnwatchView(discord.ui.View):
    def __init__(self, pg_storage, node_ids: list[str], discord_user_id: str):
        super().__init__(timeout=120)
        for nid in node_ids[:25]:
            self.add_item(_UnwatchButton(pg_storage, nid, nid[:8], discord_user_id))


class _RemoveTrackerButton(discord.ui.Button):
    """A button that removes tracking for a specific node."""

    def __init__(self, pg_storage, node_id: str, label: str):
        super().__init__(
            style=discord.ButtonStyle.danger,
            label=f"Remove {label}",
            custom_id=f"rmtracker:{node_id}",
        )
        self.pg_storage = pg_storage
        self.node_id = node_id

    async def callback(self, interaction: discord.Interaction):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return
        ok = await self.pg_storage.remove_tracker(self.node_id)
        if ok:
            await interaction.response.send_message(f"Removed tracking for `!{self.node_id}`.", ephemeral=True)
        else:
            await interaction.response.send_message(f"Node `!{self.node_id}` was not being tracked.", ephemeral=True)


class _RemoveTrackerView(discord.ui.View):
    def __init__(self, pg_storage, node_ids: list[str]):
        super().__init__(timeout=120)
        for nid in node_ids[:25]:
            self.add_item(_RemoveTrackerButton(pg_storage, nid, nid[:8]))


class _UnbanButton(discord.ui.Button):
    """A button that unbans a specific node."""

    def __init__(self, pg_storage, node_id: str, label: str):
        super().__init__(
            style=discord.ButtonStyle.success,
            label=f"Unban {label}",
            custom_id=f"unban:{node_id}",
        )
        self.pg_storage = pg_storage
        self.node_id = node_id

    async def callback(self, interaction: discord.Interaction):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return
        ok = await self.pg_storage.unban_node(self.node_id)
        if ok:
            await interaction.response.send_message(f"Unbanned node `!{self.node_id}`.", ephemeral=True)
        else:
            await interaction.response.send_message(f"Node `!{self.node_id}` was not banned.", ephemeral=True)


class _UnbanView(discord.ui.View):
    def __init__(self, pg_storage, node_ids: list[str]):
        super().__init__(timeout=120)
        for nid in node_ids[:25]:
            self.add_item(_UnbanButton(pg_storage, nid, nid[:8]))


class AdminCommands(commands.Cog):
    """Slash commands for Discord bridge administration."""

    def __init__(self, bot: commands.Bot, config: dict, data: MemoryDataStore):
        self.bot = bot
        self.config = config
        self.data = data

    async def _node_autocomplete(
        self, interaction: discord.Interaction, current: str,
    ) -> list[app_commands.Choice[str]]:
        """Shared autocomplete for node ID fields across all commands."""
        current = current.strip().lower().replace("!", "")
        if not current:
            return []

        choices: list[app_commands.Choice[str]] = []
        seen: set[str] = set()

        if not self.data.pg_storage:
            return choices

        try:
            results = await asyncio.wait_for(
                self.data.pg_storage.query_nodes_filtered(
                    days_limit=None, shortname_filter=current,
                ),
                timeout=1.5,
            )
            if len(results) < 10:
                long_results = await asyncio.wait_for(
                    self.data.pg_storage.query_nodes_filtered(
                        days_limit=None, longname_filter=current,
                    ),
                    timeout=1.0,
                )
                results.update(long_results)

            for nid, node in results.items():
                if len(choices) >= 25:
                    break
                if nid in seen:
                    continue
                longname = node.get("longname", "")
                shortname = node.get("shortname", "")
                if longname and longname != "Unknown" and shortname and shortname != "UNK":
                    label = f"{longname} [{shortname}] (!{nid})"
                elif longname and longname != "Unknown":
                    label = f"{longname} (!{nid})"
                elif shortname and shortname != "UNK":
                    label = f"{shortname} (!{nid})"
                else:
                    label = f"!{nid}"
                label = label[:100]
                choices.append(app_commands.Choice(name=label, value=nid))
                seen.add(nid)
        except Exception:
            pass

        return choices

    @staticmethod
    def _make_display_name(node: Optional[dict]) -> Optional[str]:
        """Build a display name like 'Modesto G2 Roof [NUTS]' from a node dict."""
        if not node:
            return None
        longname = node.get("longname", "")
        shortname = node.get("shortname", "")
        if longname and longname != "Unknown" and shortname and shortname != "UNK":
            return f"{longname} [{shortname}]"
        if longname and longname != "Unknown":
            return longname
        if shortname and shortname != "UNK":
            return shortname
        return None

    async def _resolve_node_id(self, raw: str) -> tuple[Optional[str], Optional[str]]:
        """
        Resolve user input to a node hex ID.

        Accepts hex IDs, integer IDs, shortnames, and longnames.
        Returns (hex_id, display_name) or (None, None) if not found.
        """
        raw = raw.strip()
        search = raw.replace("!", "").strip()

        if not self.data.pg_storage:
            return None, None

        # Try as integer ID first (digits-only input like "1234" should be decimal, not hex)
        if search.isdigit():
            try:
                id_int = int(search, 10)
                nid = utils.convert_node_id_from_int_to_hex(id_int)
                node = await self.data.pg_storage.get_node_cached(nid)
                return nid, self._make_display_name(node)
            except (ValueError, TypeError):
                pass

        # Try as hex ID
        nid = _normalize_node_id(raw)
        if nid:
            node = await self.data.pg_storage.get_node_cached(nid)
            return nid, self._make_display_name(node)

        # Try as shortname, then longname
        search_lower = raw.lower()
        node = await self.data.pg_storage.find_node_by_shortname(search_lower)
        if node is None:
            node = await self.data.pg_storage.find_node_by_longname(search_lower)
        if node is not None:
            return node.get('id'), self._make_display_name(node)

        return None, None

    def _format_node_display(self, nid: str, name: str | None) -> str:
        """Format a node ID with linked name for display in responses."""
        base_url = self.config.get('server', {}).get('base_url', '').rstrip('/')
        if name and base_url:
            return f"`!{nid}` ([{name}]({base_url}/nodes?node={nid}))"
        elif name:
            return f"`!{nid}` ({name})"
        return f"`!{nid}`"

    # ─── User Commands ────────────────────────────────────────────────

    @app_commands.command(name="linknode", description="Link a mesh node to your Discord account")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def link_node(self, interaction: discord.Interaction, node_id: str):
        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(
                f"Could not find node `{node_id}`. Try a hex ID, integer ID, short name, or long name.",
                ephemeral=True,
            )
            return

        result = await self.data.pg_storage.link_node(nid, str(interaction.user.id))
        display = self._format_node_display(nid, name)
        if result == "ok":
            await interaction.response.send_message(f"Linked node {display} to your account.", ephemeral=True)
        elif result == "already_yours":
            await interaction.response.send_message(f"Node {display} is already linked to your account.", ephemeral=True)
        elif result == "taken":
            await interaction.response.send_message(f"Node {display} is already linked to another user.", ephemeral=True)
        else:
            await interaction.response.send_message("Failed to link node. Database may be unavailable.", ephemeral=True)

    @app_commands.command(name="unlinknode", description="Unlink a mesh node from your Discord account")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def unlink_node(self, interaction: discord.Interaction, node_id: str):
        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(
                f"Could not find node `{node_id}`.", ephemeral=True,
            )
            return

        ok = await self.data.pg_storage.unlink_node(nid, str(interaction.user.id))
        display = self._format_node_display(nid, name)
        if ok:
            await interaction.response.send_message(f"Unlinked node {display} from your account.", ephemeral=True)
        else:
            await interaction.response.send_message(f"Node {display} was not linked to your account.", ephemeral=True)

    @app_commands.command(name="mylinkednodes", description="List all mesh nodes linked to your Discord account")
    async def my_linked_nodes(self, interaction: discord.Interaction):
        nodes = await self.data.pg_storage.get_linked_nodes(str(interaction.user.id))
        if not nodes:
            await interaction.response.send_message("You have no linked nodes.", ephemeral=True)
            return

        lines = []
        for nid in nodes:
            node = await self.data.pg_storage.get_node_cached(nid) if self.data.pg_storage else None
            name = self._make_display_name(node)
            lines.append(f"- {self._format_node_display(nid, name)}")

        # Build view with unlink buttons
        view = _UnlinkView(self.data.pg_storage, nodes)

        await interaction.response.send_message(
            "**Your linked nodes:**\n" + "\n".join(lines),
            view=view,
            ephemeral=True,
        )

    @app_commands.command(name="watchnode", description="Watch a node for online/offline alerts")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def watch_node(self, interaction: discord.Interaction, node_id: str):
        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(
                f"Could not find node `{node_id}`.", ephemeral=True,
            )
            return

        result = await self.data.pg_storage.watch_node(nid, str(interaction.user.id))
        display = self._format_node_display(nid, name)
        if result == "ok":
            await interaction.response.send_message(f"Now watching {display} for online/offline alerts.", ephemeral=True)
        elif result == "already":
            await interaction.response.send_message(f"You are already watching {display}.", ephemeral=True)
        else:
            await interaction.response.send_message("Failed to watch node. Database may be unavailable.", ephemeral=True)

    @app_commands.command(name="unwatchnode", description="Stop watching a node for alerts")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def unwatch_node(self, interaction: discord.Interaction, node_id: str):
        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(
                f"Could not find node `{node_id}`.", ephemeral=True,
            )
            return

        ok = await self.data.pg_storage.unwatch_node(nid, str(interaction.user.id))
        display = self._format_node_display(nid, name)
        if ok:
            await interaction.response.send_message(f"Stopped watching {display}.", ephemeral=True)
        else:
            await interaction.response.send_message(f"You were not watching {display}.", ephemeral=True)

    @app_commands.command(name="mywatchednodes", description="List all nodes you are watching for alerts")
    async def my_watched_nodes(self, interaction: discord.Interaction):
        nodes = await self.data.pg_storage.get_watched_nodes(str(interaction.user.id))
        if not nodes:
            await interaction.response.send_message("You are not watching any nodes.", ephemeral=True)
            return

        lines = []
        for nid in nodes:
            node = await self.data.pg_storage.get_node_cached(nid) if self.data.pg_storage else None
            name = self._make_display_name(node)
            lines.append(f"- {self._format_node_display(nid, name)}")

        view = _UnwatchView(self.data.pg_storage, nodes, str(interaction.user.id))

        await interaction.response.send_message(
            "**Your watched nodes:**\n" + "\n".join(lines),
            view=view,
            ephemeral=True,
        )

    # ─── Moderator Commands ──────────────────────────────────────────

    @app_commands.command(name="forceunlink", description="Force unlink a node from any user (mod only)")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def force_unlink(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Could not find node `{node_id}`.", ephemeral=True)
            return

        prev_owner = await self.data.pg_storage.force_unlink_node(nid)
        display = self._format_node_display(nid, name)
        if prev_owner:
            await interaction.response.send_message(
                f"Force unlinked {display} from <@{prev_owner}>.", ephemeral=True,
            )
        else:
            await interaction.response.send_message(f"Node {display} was not linked to anyone.", ephemeral=True)

    @app_commands.command(name="addtracker", description="Enable position forwarding for a node")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def add_tracker(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Could not find node `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.add_tracker(nid, "tracker", str(interaction.user.id))
        display = self._format_node_display(nid, name)
        if ok:
            await interaction.response.send_message(f"Position tracking enabled for {display}.")
        else:
            await interaction.response.send_message("Failed to add tracker.", ephemeral=True)

    @app_commands.command(name="removetracker", description="Disable position forwarding for a node")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def remove_tracker(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Could not find node `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.remove_tracker(nid)
        display = self._format_node_display(nid, name)
        if ok:
            await interaction.response.send_message(f"Position tracking removed for {display}.")
        else:
            await interaction.response.send_message(f"Node {display} was not being tracked.", ephemeral=True)

    @app_commands.command(name="addballoon", description="Mark a node as a balloon for position tracking")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def add_balloon(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Could not find node `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.add_tracker(nid, "balloon", str(interaction.user.id))
        display = self._format_node_display(nid, name)
        if ok:
            await interaction.response.send_message(f"Balloon tracking enabled for {display}.")
        else:
            await interaction.response.send_message("Failed to add balloon tracker.", ephemeral=True)

    @app_commands.command(name="removeballoon", description="Remove balloon marking from a node")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def remove_balloon(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Could not find node `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.remove_tracker(nid)
        display = self._format_node_display(nid, name)
        if ok:
            await interaction.response.send_message(f"Balloon tracking removed for {display}.")
        else:
            await interaction.response.send_message(f"Node {display} was not being tracked.", ephemeral=True)

    @app_commands.command(name="bannode", description="Ban a node from the Discord bridge")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name", reason="Reason for ban (optional)")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def ban_node(self, interaction: discord.Interaction, node_id: str, reason: str = ""):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Could not find node `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.ban_node(nid, str(interaction.user.id), reason)
        display = self._format_node_display(nid, name)
        if ok:
            msg = f"Node {display} has been banned from the Discord bridge."
            if reason:
                msg += f" Reason: {reason}"
            await interaction.response.send_message(msg)
        else:
            await interaction.response.send_message("Failed to ban node.", ephemeral=True)

    @app_commands.command(name="unbannode", description="Unban a node from the Discord bridge")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
    @app_commands.autocomplete(node_id=_node_autocomplete)
    async def unban_node(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Could not find node `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.unban_node(nid)
        display = self._format_node_display(nid, name)
        if ok:
            await interaction.response.send_message(f"Node {display} has been unbanned.")
        else:
            await interaction.response.send_message(f"Node {display} was not banned.", ephemeral=True)

    @app_commands.command(name="listtrackers", description="List all nodes being tracked for position updates")
    async def list_trackers(self, interaction: discord.Interaction):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        trackers = await self.data.pg_storage.list_trackers()
        if not trackers:
            await interaction.response.send_message("No nodes are currently being tracked.", ephemeral=True)
            return

        lines = []
        node_ids = []
        for t in trackers:
            nid = t["node_id"]
            node_ids.append(nid)
            track_type = t.get("track_type", "tracker")
            label = "Balloon" if track_type == "balloon" else "Tracker"
            # Resolve name
            node = await self.data.pg_storage.get_node_cached(nid) if self.data.pg_storage else None
            name = self._make_display_name(node)
            display = self._format_node_display(nid, name)
            added_by = t.get("added_by", "")
            added_str = f" (by <@{added_by}>)" if added_by else ""
            lines.append(f"- [{label}] {display}{added_str}")

        view = _RemoveTrackerView(self.data.pg_storage, node_ids)
        await interaction.response.send_message(
            f"**Tracked nodes ({len(trackers)}):**\n" + "\n".join(lines),
            view=view,
            ephemeral=True,
        )

    @app_commands.command(name="listbans", description="List all nodes banned from the Discord bridge")
    async def list_bans(self, interaction: discord.Interaction):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        bans = await self.data.pg_storage.list_bans()
        if not bans:
            await interaction.response.send_message("No nodes are currently banned.", ephemeral=True)
            return

        lines = []
        node_ids = []
        for b in bans:
            nid = b["node_id"]
            node_ids.append(nid)
            # Resolve name
            node = await self.data.pg_storage.get_node_cached(nid) if self.data.pg_storage else None
            name = self._make_display_name(node)
            display = self._format_node_display(nid, name)
            reason = b.get("reason", "")
            banned_by = b.get("banned_by", "")
            extra = []
            if banned_by:
                extra.append(f"by <@{banned_by}>")
            if reason:
                extra.append(f"reason: {reason}")
            extra_str = f" ({', '.join(extra)})" if extra else ""
            lines.append(f"- {display}{extra_str}")

        view = _UnbanView(self.data.pg_storage, node_ids)
        await interaction.response.send_message(
            f"**Banned nodes ({len(bans)}):**\n" + "\n".join(lines),
            view=view,
            ephemeral=True,
        )
