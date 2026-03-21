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

import discord
from discord import app_commands
from discord.ext import commands

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


class AdminCommands(commands.Cog):
    """Slash commands for Discord bridge administration."""

    def __init__(self, bot: commands.Bot, config: dict, data: MemoryDataStore):
        self.bot = bot
        self.config = config
        self.data = data

    # ─── User Commands ────────────────────────────────────────────────

    @app_commands.command(name="linknode", description="Link a mesh node to your Discord account")
    @app_commands.describe(node_id="Mesh node ID (hex, e.g. !1a2b3c4d or 1a2b3c4d)")
    async def link_node(self, interaction: discord.Interaction, node_id: str):
        nid = _normalize_node_id(node_id)
        if not nid:
            await interaction.response.send_message(
                f"Invalid node ID: `{node_id}`. Use 8 hex characters (e.g. `!1a2b3c4d`).",
                ephemeral=True,
            )
            return

        ok = await self.data.pg_storage.link_node(nid, str(interaction.user.id))
        if ok:
            await interaction.response.send_message(
                f"Linked node `!{nid}` to your account.", ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                "Failed to link node. Database may be unavailable.", ephemeral=True,
            )

    @app_commands.command(name="unlinknode", description="Unlink a mesh node from your Discord account")
    @app_commands.describe(node_id="Mesh node ID (hex)")
    async def unlink_node(self, interaction: discord.Interaction, node_id: str):
        nid = _normalize_node_id(node_id)
        if not nid:
            await interaction.response.send_message(
                f"Invalid node ID: `{node_id}`.", ephemeral=True,
            )
            return

        ok = await self.data.pg_storage.unlink_node(nid, str(interaction.user.id))
        if ok:
            await interaction.response.send_message(
                f"Unlinked node `!{nid}` from your account.", ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                f"Node `!{nid}` was not linked to your account.", ephemeral=True,
            )

    @app_commands.command(name="mylinkednodes", description="List all mesh nodes linked to your Discord account")
    async def my_linked_nodes(self, interaction: discord.Interaction):
        nodes = await self.data.pg_storage.get_linked_nodes(str(interaction.user.id))
        if not nodes:
            await interaction.response.send_message("You have no linked nodes.", ephemeral=True)
            return

        lines = [f"- `!{nid}`" for nid in nodes]
        # Resolve names where available
        for i, nid in enumerate(nodes):
            node = self.data.nodes.get(nid)
            if node:
                name = node.get("longname", node.get("shortname", ""))
                if name and name not in ("Unknown", "UNK"):
                    lines[i] = f"- `!{nid}` ({name})"

        await interaction.response.send_message(
            "**Your linked nodes:**\n" + "\n".join(lines),
            ephemeral=True,
        )

    # ─── Moderator Commands ──────────────────────────────────────────

    @app_commands.command(name="addtracker", description="Enable position forwarding for a node")
    @app_commands.describe(node_id="Mesh node ID (hex)")
    async def add_tracker(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid = _normalize_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Invalid node ID: `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.add_tracker(nid, "tracker", str(interaction.user.id))
        if ok:
            await interaction.response.send_message(f"Position tracking enabled for `!{nid}`.")
        else:
            await interaction.response.send_message("Failed to add tracker.", ephemeral=True)

    @app_commands.command(name="removetracker", description="Disable position forwarding for a node")
    @app_commands.describe(node_id="Mesh node ID (hex)")
    async def remove_tracker(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid = _normalize_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Invalid node ID: `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.remove_tracker(nid)
        if ok:
            await interaction.response.send_message(f"Position tracking removed for `!{nid}`.")
        else:
            await interaction.response.send_message(f"Node `!{nid}` was not being tracked.", ephemeral=True)

    @app_commands.command(name="addballoon", description="Mark a node as a balloon for position tracking")
    @app_commands.describe(node_id="Mesh node ID (hex)")
    async def add_balloon(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid = _normalize_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Invalid node ID: `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.add_tracker(nid, "balloon", str(interaction.user.id))
        if ok:
            await interaction.response.send_message(f"Balloon tracking enabled for `!{nid}`.")
        else:
            await interaction.response.send_message("Failed to add balloon tracker.", ephemeral=True)

    @app_commands.command(name="removeballoon", description="Remove balloon marking from a node")
    @app_commands.describe(node_id="Mesh node ID (hex)")
    async def remove_balloon(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid = _normalize_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Invalid node ID: `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.remove_tracker(nid)
        if ok:
            await interaction.response.send_message(f"Balloon tracking removed for `!{nid}`.")
        else:
            await interaction.response.send_message(f"Node `!{nid}` was not being tracked.", ephemeral=True)

    @app_commands.command(name="bannode", description="Ban a node from the Discord bridge")
    @app_commands.describe(node_id="Mesh node ID (hex)", reason="Reason for ban (optional)")
    async def ban_node(self, interaction: discord.Interaction, node_id: str, reason: str = ""):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid = _normalize_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Invalid node ID: `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.ban_node(nid, str(interaction.user.id), reason)
        if ok:
            msg = f"Node `!{nid}` has been banned from the Discord bridge."
            if reason:
                msg += f" Reason: {reason}"
            await interaction.response.send_message(msg)
        else:
            await interaction.response.send_message("Failed to ban node.", ephemeral=True)

    @app_commands.command(name="unbannode", description="Unban a node from the Discord bridge")
    @app_commands.describe(node_id="Mesh node ID (hex)")
    async def unban_node(self, interaction: discord.Interaction, node_id: str):
        if not _is_mod(interaction):
            await interaction.response.send_message("You need Manage Messages permission.", ephemeral=True)
            return

        nid = _normalize_node_id(node_id)
        if not nid:
            await interaction.response.send_message(f"Invalid node ID: `{node_id}`.", ephemeral=True)
            return

        ok = await self.data.pg_storage.unban_node(nid)
        if ok:
            await interaction.response.send_message(f"Node `!{nid}` has been unbanned.")
        else:
            await interaction.response.send_message(f"Node `!{nid}` was not banned.", ephemeral=True)
