import asyncio
import datetime
import logging
from typing import Optional
from zoneinfo import ZoneInfo

import discord
from discord import app_commands
from discord.ext import commands
from meshtastic import mesh_pb2, config_pb2

import utils
from data_store import DataStore

logger = logging.getLogger(__name__)


class MainCommands(commands.Cog):
    def __init__(self, bot, config, data):
        self.bot = bot
        self.config = config
        self.data: DataStore = data

    @commands.Cog.listener()
    async def on_ready(self):
        logger.info('Discord: Logged in')

    # ─── Shared autocomplete ─────────────────────────────────────────

    async def _node_autocomplete(
        self, interaction: discord.Interaction, current: str,
    ) -> list[app_commands.Choice[str]]:
        """Autocomplete for node fields — searches hex ID, shortname, longname."""
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

    # ─── Node resolution helper ──────────────────────────────────────

    async def _resolve_node(self, search: str) -> tuple[Optional[str], Optional[dict]]:
        """Resolve user input to (hex_id, node_dict). Returns (None, None) if not found."""
        search = search.strip().lower().replace("!", "")
        if not search:
            return None, None

        node = None
        id_hex = None

        # Try parsing as integer node ID
        try:
            id_int = int(search, 10)
            id_hex = utils.convert_node_id_from_int_to_hex(id_int)
        except ValueError:
            pass

        # Try parsing as hex node ID
        if id_hex is None and all(c in '0123456789abcdef' for c in search) and len(search) <= 8:
            id_hex = search.zfill(8)

        if not self.data.pg_storage:
            return id_hex, None

        if id_hex:
            node = await self.data.pg_storage.get_node_cached(id_hex)
        if node is None:
            node = await self.data.pg_storage.find_node_by_shortname(search)
        if node is None:
            node = await self.data.pg_storage.find_node_by_longname(search)
        if node is not None:
            id_hex = node.get('id', id_hex)

        return id_hex, node

    # ─── Commands ────────────────────────────────────────────────────

    @app_commands.command(name="lookup", description="Look up a node by name, hex ID, or integer ID")
    @app_commands.describe(node="Node name, hex ID, or integer ID")
    @app_commands.autocomplete(node=_node_autocomplete)
    async def lookup_node(self, interaction: discord.Interaction, node: str):
        logger.info("Discord: /lookup: Looking up %s", node)
        id_hex, node_data = await self._resolve_node(node)

        if node_data is None:
            await interaction.response.send_message(f"Node `{node}` not found.", ephemeral=True)
            return

        id_hex = node_data.get('id', id_hex) or id_hex
        id_int = utils.convert_node_id_from_hex_to_int(id_hex)
        shortname = node_data.get('shortname', 'UNK')
        longname = node_data.get('longname', 'Unknown')
        hardware_raw = node_data.get('hardware', None)
        hardware = "Unknown"
        if hardware_raw is not None:
            try:
                hw_int = int(hardware_raw)
                hw_name = mesh_pb2.HardwareModel.Name(hw_int)
                if hw_name == "PRIVATE_HW":
                    hardware = "Private"
                else:
                    hardware = hw_name.replace("_", " ").title()
            except (ValueError, TypeError):
                hardware = str(hardware_raw)
        active = node_data.get('active', False)
        last_seen_raw = node_data.get('last_seen', None)
        if isinstance(last_seen_raw, str):
            try:
                dt = datetime.datetime.fromisoformat(last_seen_raw)
                tz = ZoneInfo(self.config['server']['timezone'])
                last_seen = dt.astimezone(tz).strftime("%b %d, %Y %I:%M %p %Z")
            except (ValueError, TypeError):
                last_seen = last_seen_raw
        elif isinstance(last_seen_raw, datetime.datetime):
            tz = ZoneInfo(self.config['server']['timezone'])
            last_seen = last_seen_raw.astimezone(tz).strftime("%b %d, %Y %I:%M %p %Z")
        else:
            last_seen = "Unknown"
        role = node_data.get('role', 0)

        logger.info("Discord: /lookup: Found %s (%s)", id_hex, longname)

        base_url = self.config['server']['base_url'].strip('/')
        embed = discord.Embed(
            title=f"{shortname}: {longname}",
            url=f"{base_url}/nodes?node={id_hex}",
            color=discord.Color.green() if active else discord.Color.greyple())
        embed.set_thumbnail(url=f"https://api.dicebear.com/9.x/bottts-neutral/png?seed={id_hex}")
        embed.add_field(name="ID (hex)", value=f"!{id_hex}", inline=True)
        embed.add_field(name="ID (int)", value=str(id_int), inline=True)
        embed.add_field(name="Status", value=("Online" if active else "Offline"), inline=True)
        embed.add_field(name="Hardware", value=hardware, inline=True)
        if role:
            try:
                role_name = config_pb2.Config.DeviceConfig.Role.Name(role).replace("_", " ").title()
            except ValueError:
                role_name = f"Role {role}"
            embed.add_field(name="Role", value=role_name, inline=True)
        embed.add_field(name="Last Seen", value=str(last_seen), inline=False)

        position = node_data.get('position', {})
        if position and position.get('latitude_i') and position.get('longitude_i'):
            lat = position['latitude_i'] / 1e7
            lon = position['longitude_i'] / 1e7
            embed.add_field(name="Position", value=f"{lat:.5f}, {lon:.5f}", inline=True)
            if position.get('altitude'):
                embed.add_field(name="Altitude", value=f"{position['altitude']}m", inline=True)

        telemetry = node_data.get('telemetry', {})
        if telemetry:
            telem_parts = []
            if 'battery_level' in telemetry and telemetry['battery_level'] is not None:
                telem_parts.append(f"Battery: {telemetry['battery_level']}%")
            if 'voltage' in telemetry and telemetry['voltage'] is not None:
                telem_parts.append(f"Voltage: {telemetry['voltage']:.2f}V")
            if 'temperature' in telemetry and telemetry['temperature'] is not None:
                telem_parts.append(f"Temp: {telemetry['temperature']:.1f}\u00b0C")
            if telem_parts:
                embed.add_field(name="Telemetry", value=" | ".join(telem_parts), inline=False)

        elsewhere = self.config.get('mesh', {}).get('elsewhere_links', [])
        if elsewhere:
            link_parts = []
            for link in elsewhere:
                name = link.get('name', '')
                url = link.get('url', '')
                if name and url:
                    url = url.replace('{node_id_hex}', id_hex)
                    url = url.replace('{node_id_int}', str(id_int))
                    link_parts.append(f"[{name}]({url})")
            if link_parts:
                embed.add_field(name="View Elsewhere", value=" | ".join(link_parts), inline=False)

        # Owner tag if node is linked
        if self.data.pg_storage:
            owner_id = await self.data.pg_storage.get_node_owner(id_hex)
            if owner_id:
                embed.add_field(name="Owner", value=f"<@{owner_id}>", inline=True)

        embed.set_footer(text=f"Node: !{id_hex}")
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="lookupuser", description="See all mesh nodes linked to a Discord user")
    @app_commands.describe(user="Discord user to look up")
    async def lookup_user(self, interaction: discord.Interaction, user: discord.User):
        logger.info("Discord: /lookupuser: Looking up nodes for %s", user)

        if not self.data.pg_storage:
            await interaction.response.send_message("Database not available.", ephemeral=True)
            return

        nodes = await self.data.pg_storage.get_linked_nodes(str(user.id))
        if not nodes:
            await interaction.response.send_message(
                f"{user.mention} has no linked nodes.", ephemeral=True,
            )
            return

        base_url = self.config['server']['base_url'].strip('/')
        embed = discord.Embed(
            title=f"Nodes linked to {user.display_name}",
            color=discord.Color.blue(),
        )
        embed.set_thumbnail(url=user.display_avatar.url)

        for nid in nodes[:25]:  # Discord embed field limit
            node = await self.data.pg_storage.get_node_cached(nid)

            shortname = (node.get('shortname') or 'UNK') if node else 'UNK'
            longname = (node.get('longname') or 'Unknown') if node else 'Unknown'
            active = node.get('active', False) if node else False
            status = "Online" if active else "Offline"

            embed.add_field(
                name=f"{shortname}: {longname}",
                value=f"[!{nid}]({base_url}/nodes?node={nid}) — {status}",
                inline=False,
            )

        embed.set_footer(text=f"{len(nodes)} node{'s' if len(nodes) != 1 else ''} linked")
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="mesh", description="Information about the mesh")
    async def mesh_info(self, interaction: discord.Interaction):
        logger.info("Discord: /mesh: Mesh info requested by %s", interaction.user)

        stats = {}
        if self.data.pg_storage:
            stats = await self.data.pg_storage.query_stats()

        total_nodes = stats.get("total_nodes", 0)
        active_nodes = stats.get("active_nodes", 0)

        base_url = self.config['server']['base_url'].strip('/')
        embed = discord.Embed(
            title=f"{self.config['mesh']['name']}",
            url=base_url,
            color=discord.Color.blue())
        embed.add_field(name="Description", value=self.config['mesh']['description'] or "N/A", inline=False)
        location = f"{self.config['mesh']['metro']}, {self.config['mesh']['region']}, {self.config['mesh']['country']}"
        embed.add_field(name="Location", value=location, inline=True)
        embed.add_field(name="Timezone", value=self.config['server']['timezone'], inline=True)
        if self.config['mesh'].get('url'):
            embed.add_field(name="Website", value=self.config['mesh']['url'], inline=False)
        embed.add_field(name="Total Nodes", value=f"[{total_nodes}]({base_url}/nodes)", inline=True)
        embed.add_field(name="Online Nodes", value=f"[{active_nodes}]({base_url}/nodes?st=online)", inline=True)
        uptime = datetime.datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - self.config['server']['start_time']
        embed.add_field(name="Server Uptime", value=f"{uptime.days}d {uptime.seconds // 3600}h {(uptime.seconds % 3600) // 60}m {uptime.seconds % 60}s", inline=False)
        links = [f"[Dashboard]({base_url})", f"[Nodes]({base_url}/nodes)", f"[Chat]({base_url}/chat)", f"[Logs]({base_url}/logs)"]
        embed.add_field(name="Quick Links", value=" | ".join(links), inline=False)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="ping", description="Ping the bot")
    async def ping(self, interaction: discord.Interaction):
        await interaction.response.send_message(f'Pong! {round(self.bot.latency * 1000)}ms')

    @app_commands.command(name="uptime", description="Uptime of MeshInfo instance")
    async def uptime(self, interaction: discord.Interaction):
        now = datetime.datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
        uptime = now - self.config['server']['start_time']
        await interaction.response.send_message(f'MeshInfo uptime: {uptime.days}d {uptime.seconds // 3600}h {(uptime.seconds % 3600) // 60}m {uptime.seconds % 60}s')

    @app_commands.command(name="topnodes", description="Mesh leaderboard and achievements")
    @app_commands.describe(timeframe="Time period: 24h (default) or 7d")
    async def topnodes(self, interaction: discord.Interaction, timeframe: str = "24h"):
        await interaction.response.defer()

        if timeframe in ("7d", "7", "week"):
            hours = 168
            label = "7 Days"
        else:
            hours = 24
            label = "24 Hours"

        if not self.data.pg_storage:
            await interaction.followup.send("Database not available.", ephemeral=True)
            return

        # Determine mesh channel from Discord channel via bridge config
        mesh_channel = None
        channel_label = None
        bridge_cfg = self.config.get('integrations', {}).get('discord', {}).get('bridge', {})
        bridge_channels = bridge_cfg.get('channels', {})
        discord_ch_id = str(interaction.channel_id)
        for mesh_ch, disc_ch in bridge_channels.items():
            if str(disc_ch) == discord_ch_id:
                mesh_channel = mesh_ch
                # Resolve a friendly label from channel meta
                meta = self.config.get('broker', {}).get('channels', {}).get('meta', {}).get(mesh_ch, {})
                channel_label = meta.get('label') or f"Channel {mesh_ch}"
                break

        stats = await self.data.pg_storage.query_top_nodes(hours=hours, limit=5, channel_id=mesh_channel)
        if not stats:
            await interaction.followup.send("No leaderboard data available yet.", ephemeral=True)
            return

        base_url = self.config.get('server', {}).get('base_url', '').rstrip('/')

        async def resolve_name(node_id: str) -> str:
            n = None
            if self.data.pg_storage:
                n = await self.data.pg_storage.get_node_cached(node_id)
            if n:
                name = n.get("longname") or n.get("shortname")
                if name and name not in ("Unknown", "UNK"):
                    if base_url:
                        return f"[{name}]({base_url}/nodes?node={node_id})"
                    return name
            return f"!{node_id}"

        title = f"Mesh Leaderboard \u2014 {label}"
        if channel_label:
            title += f" \u2014 {channel_label}"
        embed = discord.Embed(
            title=title,
            color=discord.Color.gold(),
            timestamp=discord.utils.utcnow(),
        )

        medals = ["\U0001f947", "\U0001f948", "\U0001f949", "4.", "5."]

        chatterbox = stats.get("chatterbox", [])
        if chatterbox:
            lines = []
            for i, row in enumerate(chatterbox):
                name = await resolve_name(row["node_id"])
                lines.append(f"{medals[i]} {name} \u2014 **{row['count']}** msgs")
            embed.add_field(name="\U0001f4ac Chatterbox", value="\n".join(lines), inline=False)

        iron_man = stats.get("iron_man", [])
        if iron_man:
            lines = []
            for i, row in enumerate(iron_man):
                name = await resolve_name(row["node_id"])
                secs = float(row["uptime_seconds"])
                days = int(secs // 86400)
                lines.append(f"{medals[i]} {name} \u2014 **{days}** days")
            embed.add_field(name="\U0001f9be Iron Man", value="\n".join(lines), inline=False)

        # Here I Am — disabled until position history table is added
        # here_i_am = stats.get("here_i_am", [])
        # if here_i_am:
        #     lines = []
        #     for i, row in enumerate(here_i_am):
        #         name = await resolve_name(row["node_id"])
        #         lines.append(f"{medals[i]} {name} \u2014 **{row['count']}** updates")
        #     embed.add_field(name="\U0001f4cd Here I Am", value="\n".join(lines), inline=False)

        loudest = stats.get("loudest_signal", [])
        if loudest:
            lines = []
            for i, row in enumerate(loudest):
                name = await resolve_name(row["node_id"])
                lines.append(f"{medals[i]} {name} \u2014 **{row['avg_snr']}** dB avg SNR")
            embed.add_field(name="\U0001f4e1 Loudest Signal", value="\n".join(lines), inline=False)

        gateway_mvp = stats.get("gateway_mvp", [])
        if gateway_mvp:
            lines = []
            for i, row in enumerate(gateway_mvp):
                name = await resolve_name(row["node_id"])
                lines.append(f"{medals[i]} {name} \u2014 **{row['count']}** relayed")
            embed.add_field(name="\U0001f310 Gateway MVP", value="\n".join(lines), inline=False)

        if not any(stats.values()):
            embed.description = "Not enough data yet \u2014 check back later!"

        footer_parts = [f"Timeframe: {label}"]
        if mesh_channel:
            footer_parts.append(f"Channel: {mesh_channel}")
        footer_parts.append("Use /topnodes 7d for weekly")
        embed.set_footer(text=" | ".join(footer_parts))
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="meshinfo", description="Show all available bot commands")
    async def meshinfo_help(self, interaction: discord.Interaction):
        base_url = self.config.get('server', {}).get('base_url', '').rstrip('/')
        embed = discord.Embed(
            title="MeshInfo Bot Commands",
            url=base_url or None,
            color=discord.Color.blue(),
        )
        embed.add_field(
            name="General",
            value=(
                "`/lookup` \u2014 Look up a node by name, hex ID, or integer ID\n"
                "`/mesh` \u2014 View mesh network info and node counts\n"
                "`/whereis` \u2014 Show a node's last known position on a map\n"
                "`/topnodes` \u2014 Mesh leaderboard and achievements\n"
                "`/ping` \u2014 Check bot latency\n"
                "`/uptime` \u2014 MeshInfo server uptime\n"
                "`/meshinfo` \u2014 This help message"
            ),
            inline=False,
        )
        embed.add_field(
            name="Node Linking & Watching",
            value=(
                "*Only link nodes you own. Each node can have one owner.*\n"
                "`/linknode` \u2014 Claim a node as yours\n"
                "`/unlinknode` \u2014 Remove your claim\n"
                "`/mylinkednodes` \u2014 See your linked nodes\n"
                "*Watch any node for alerts \u2014 no ownership required.*\n"
                "`/watchnode` \u2014 Get alerts when a node goes online/offline\n"
                "`/unwatchnode` \u2014 Stop watching a node\n"
                "`/mywatchednodes` \u2014 See your watched nodes"
            ),
            inline=False,
        )
        embed.add_field(
            name="Moderator",
            value=(
                "`/forceunlink` \u2014 Force unlink a node from any user\n"
                "`/addtracker` / `/removetracker` \u2014 Manage position tracking\n"
                "`/addballoon` / `/removeballoon` \u2014 Manage balloon tracking\n"
                "`/bannode` / `/unbannode` \u2014 Manage bridge bans\n"
                "`/listtrackers` \u2014 View all tracked nodes\n"
                "`/listbans` \u2014 View all banned nodes"
            ),
            inline=False,
        )
        embed.add_field(
            name="Signal Quality Colors",
            value=(
                "\U0001f7e2 **> 10 dB** Excellent\n"
                "\U0001f535 **5\u201310 dB** Good\n"
                "\U0001f7e1 **0\u20135 dB** Fair\n"
                "\U0001f7e0 **-5\u20130 dB** Weak\n"
                "\U0001f534 **< -5 dB** Poor"
            ),
            inline=False,
        )
        embed.set_footer(text="All node commands support autocomplete \u2014 start typing a name!")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="whereis", description="Show a node's last known position")
    @app_commands.describe(node="Node name, hex ID, or integer ID")
    @app_commands.autocomplete(node=_node_autocomplete)
    async def whereis(self, interaction: discord.Interaction, node: str):
        id_hex, node_data = await self._resolve_node(node)

        if node_data is None:
            await interaction.response.send_message(f"Node `{node}` not found.", ephemeral=True)
            return

        id_hex = node_data.get('id', id_hex) or id_hex
        position = node_data.get('position', {})
        if not position or not position.get('latitude_i') or not position.get('longitude_i'):
            shortname = node_data.get('shortname', id_hex)
            await interaction.response.send_message(f"No position data available for **{shortname}**.", ephemeral=True)
            return

        lat = position['latitude_i'] / 1e7
        lon = position['longitude_i'] / 1e7
        alt = position.get('altitude')
        shortname = node_data.get('shortname', 'UNK')
        longname = node_data.get('longname', 'Unknown')
        base_url = self.config.get('server', {}).get('base_url', '').rstrip('/')
        map_link = f"{base_url}/map?node={id_hex}" if base_url else None

        embed = discord.Embed(
            title=f"{longname} [{shortname}]",
            url=map_link,
            color=discord.Color.blue(),
        )
        avatar_url = f"https://api.dicebear.com/9.x/bottts-neutral/png?seed={id_hex}"
        embed.set_author(name="Last Known Position", icon_url=avatar_url)

        coord_text = f"[{lat:.6f}, {lon:.6f}]({map_link})" if map_link else f"{lat:.6f}, {lon:.6f}"
        embed.add_field(name="Position", value=coord_text, inline=True)
        if alt is not None:
            embed.add_field(name="Altitude", value=f"{alt}m", inline=True)

        maps_cfg = self.config.get("integrations", {}).get("discord", {}).get("bridge", {}).get("maps", {})
        provider = maps_cfg.get("provider", "none")
        if provider != "none" and base_url:
            thumbnail_url = f"{base_url}/v1/static-map?lat={lat:.6f}&lon={lon:.6f}&zoom=12"
            embed.set_image(url=thumbnail_url)

        embed.set_footer(text=f"Node: !{id_hex}")
        await interaction.response.send_message(embed=embed)
