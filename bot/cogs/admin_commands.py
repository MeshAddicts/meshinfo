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


class AdminCommands(commands.Cog):
    """Slash commands for Discord bridge administration."""

    def __init__(self, bot: commands.Bot, config: dict, data: MemoryDataStore):
        self.bot = bot
        self.config = config
        self.data = data

    async def _resolve_node_id(self, raw: str) -> tuple[Optional[str], Optional[str]]:
        """
        Resolve user input to a node hex ID.

        Accepts hex IDs, integer IDs, shortnames, and longnames.
        Returns (hex_id, display_name) or (None, None) if not found.
        """
        raw = raw.strip()

        # Try as hex ID
        nid = _normalize_node_id(raw)
        if nid:
            # Verify it exists (optional — allow linking to unknown nodes)
            node = self.data.nodes.get(nid)
            if node:
                name = node.get("longname", node.get("shortname", ""))
                return nid, name if name not in ("Unknown", "UNK", "") else None
            # Check DB
            if self.data.pg_storage:
                db_node = await self.data.pg_storage.query_node_by_id(nid)
                if db_node:
                    name = db_node.get("longname", db_node.get("shortname", ""))
                    return nid, name if name not in ("Unknown", "UNK", "") else None
            # Valid hex but not in DB — still allow it
            return nid, None

        # Try as integer ID
        search = raw.replace("!", "").strip()
        try:
            id_int = int(search, 10)
            nid = utils.convert_node_id_from_int_to_hex(id_int)
            return nid, None
        except (ValueError, TypeError):
            pass

        # Try as shortname/longname in memory
        search_lower = raw.lower()
        for node_id, node in self.data.nodes.items():
            if (str(node.get("shortname", "")).lower() == search_lower or
                    str(node.get("longname", "")).lower() == search_lower):
                name = node.get("longname", node.get("shortname", ""))
                return node_id, name if name not in ("Unknown", "UNK", "") else None

        # Try as shortname/longname in PostgreSQL
        if self.data.pg_storage:
            results = await self.data.pg_storage.query_nodes_filtered(
                days_limit=None, shortname_filter=search_lower,
            )
            if results:
                nid, node = next(iter(results.items()))
                name = node.get("longname", node.get("shortname", ""))
                return nid, name if name not in ("Unknown", "UNK", "") else None

            results = await self.data.pg_storage.query_nodes_filtered(
                days_limit=None, longname_filter=search_lower,
            )
            if results:
                nid, node = next(iter(results.items()))
                name = node.get("longname", node.get("shortname", ""))
                return nid, name if name not in ("Unknown", "UNK", "") else None

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
    async def link_node(self, interaction: discord.Interaction, node_id: str):
        nid, name = await self._resolve_node_id(node_id)
        if not nid:
            await interaction.response.send_message(
                f"Could not find node `{node_id}`. Try a hex ID, integer ID, short name, or long name.",
                ephemeral=True,
            )
            return

        ok = await self.data.pg_storage.link_node(nid, str(interaction.user.id))
        display = self._format_node_display(nid, name)
        if ok:
            await interaction.response.send_message(f"Linked node {display} to your account.", ephemeral=True)
        else:
            await interaction.response.send_message("Failed to link node. Database may be unavailable.", ephemeral=True)

    @app_commands.command(name="unlinknode", description="Unlink a mesh node from your Discord account")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
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
            node = self.data.nodes.get(nid)
            if not node and self.data.pg_storage:
                node = await self.data.pg_storage.query_node_by_id(nid)
            name = None
            if node:
                n = node.get("longname", node.get("shortname", ""))
                if n and n not in ("Unknown", "UNK"):
                    name = n
            lines.append(f"- {self._format_node_display(nid, name)}")

        # Build view with unlink buttons
        view = _UnlinkView(self.data.pg_storage, nodes)

        await interaction.response.send_message(
            "**Your linked nodes:**\n" + "\n".join(lines),
            view=view,
            ephemeral=True,
        )

    # ─── Moderator Commands ──────────────────────────────────────────

    @app_commands.command(name="addtracker", description="Enable position forwarding for a node")
    @app_commands.describe(node_id="Node ID (hex), integer ID, short name, or long name")
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
