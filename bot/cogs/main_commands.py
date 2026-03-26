import datetime
import logging
from zoneinfo import ZoneInfo
from discord.ext import commands
import discord
from meshtastic import mesh_pb2

import utils

logger = logging.getLogger(__name__)


class LookupFlags(commands.FlagConverter):
    node: str = commands.flag(description='Node')

class MainCommands(commands.Cog):
    def __init__(self, bot, config, data):
        self.bot = bot
        self.config = config
        self.data = data

    @commands.Cog.listener()
    async def on_ready(self):
        logger.info('Discord: Logged in')

    @commands.hybrid_command(name="lookup", description="Look up a node by ID (int or hex), short name, or long name")
    async def lookup_node(self, ctx, *, flags: LookupFlags):
        logger.info("Discord: /lookup: Looking up %s", flags.node)
        search = flags.node.strip().lower().replace("!", "")
        if not search:
            await ctx.send("Please provide a node ID or name to look up.")
            return

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

        # 1) Check in-memory first (fastest)
        if id_hex and id_hex in self.data.nodes:
            node = self.data.nodes[id_hex]
        else:
            # Search in-memory by shortname or longname
            for node_id, n in self.data.nodes.items():
                if (str(n.get('shortname', '')).lower() == search or
                        str(n.get('longname', '')).lower() == search):
                    node = n
                    id_hex = node_id
                    break

        # 2) Fall back to PostgreSQL
        if node is None and self.data.pg_storage:
            # Try by ID first
            if id_hex:
                node = await self.data.pg_storage.query_node_by_id(id_hex)

            # Try by shortname
            if node is None:
                results = await self.data.pg_storage.query_nodes_filtered(
                    days_limit=None, shortname_filter=search,
                )
                if results:
                    id_hex, node = next(iter(results.items()))

            # Try by longname
            if node is None:
                results = await self.data.pg_storage.query_nodes_filtered(
                    days_limit=None, longname_filter=search,
                )
                if results:
                    id_hex, node = next(iter(results.items()))

        if node is None:
            await ctx.send(f"Node `{flags.node}` not found.")
            return

        id_hex = node.get('id', id_hex) or id_hex
        id_int = utils.convert_node_id_from_hex_to_int(id_hex)
        shortname = node.get('shortname', 'UNK')
        longname = node.get('longname', 'Unknown')
        hardware_raw = node.get('hardware', None)
        hardware = "Unknown"
        if hardware_raw is not None:
            # DB stores as string or int; normalize to int for enum lookup
            try:
                hw_int = int(hardware_raw)
                hw_name = mesh_pb2.HardwareModel.Name(hw_int)
                if hw_name == "PRIVATE_HW":
                    hardware = "Private"
                else:
                    hardware = hw_name.replace("_", " ").title()
            except (ValueError, TypeError):
                hardware = str(hardware_raw)
        active = node.get('active', False)
        last_seen_raw = node.get('last_seen', None)
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
        role = node.get('role', 0)

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
            role_labels = {
                0: "Client", 1: "Client Mute", 2: "Router", 3: "Router Client",
                4: "Repeater", 5: "Tracker", 6: "Sensor", 7: "ATAK",
                8: "Client Hidden", 9: "Lost and Found", 10: "ATAK Tracker",
            }
            embed.add_field(name="Role", value=role_labels.get(role, f"Role {role}"), inline=True)
        embed.add_field(name="Last Seen", value=str(last_seen), inline=False)

        # Position info if available
        position = node.get('position', {})
        if position and position.get('latitude_i') and position.get('longitude_i'):
            lat = position['latitude_i'] / 1e7
            lon = position['longitude_i'] / 1e7
            embed.add_field(name="Position", value=f"{lat:.5f}, {lon:.5f}", inline=True)
            if position.get('altitude'):
                embed.add_field(name="Altitude", value=f"{position['altitude']}m", inline=True)

        # Telemetry if available
        telemetry = node.get('telemetry', {})
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

        # Elsewhere links from config
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

        embed.set_footer(text=f"Node: !{id_hex}")
        await ctx.send(embed=embed)

    @commands.hybrid_command(name="mesh", description="Information about the mesh")
    async def mesh_info(self, ctx):
        logger.info("Discord: /mesh: Mesh info requested by %s", ctx.author)

        # Get node counts from PostgreSQL for accuracy
        stats = {}
        if self.data.pg_storage:
            stats = await self.data.pg_storage.query_stats()

        total_nodes = stats.get("total_nodes", len(self.data.nodes))
        active_nodes = stats.get("active_nodes", len([n for n in self.data.nodes.values() if n.get('active')]))

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
        embed.add_field(name="Online Nodes", value=f"[{active_nodes}]({base_url}/nodes?status=online)", inline=True)
        uptime = datetime.datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - self.config['server']['start_time']
        embed.add_field(name="Server Uptime", value=f"{uptime.days}d {uptime.seconds // 3600}h {(uptime.seconds % 3600) // 60}m {uptime.seconds % 60}s", inline=False)
        links = [f"[Dashboard]({base_url})", f"[Nodes]({base_url}/nodes)", f"[Chat]({base_url}/chat)", f"[Logs]({base_url}/logs)"]
        embed.add_field(name="Quick Links", value=" | ".join(links), inline=False)
        await ctx.send(embed=embed)

    @commands.hybrid_command(name="ping", description="Ping the bot")
    async def ping(self, ctx):
        await ctx.send(f'Pong! {round(self.bot.latency * 1000)}ms')

    @commands.hybrid_command(name="uptime", description="Uptime of MeshInfo instance")
    async def uptime(self, ctx):
        now = datetime.datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
        uptime = now - self.config['server']['start_time']
        await ctx.send(f'MeshInfo uptime: {uptime.days}d {uptime.seconds // 3600}h {(uptime.seconds % 3600) // 60}m {uptime.seconds % 60}s')

    @commands.hybrid_command(name="topnodes", description="Mesh leaderboard and achievements")
    async def topnodes(self, ctx, timeframe: str = "24h"):
        if timeframe in ("7d", "7", "week"):
            hours = 168
            label = "7 Days"
        else:
            hours = 24
            label = "24 Hours"

        if not self.data.pg_storage:
            await ctx.send("Database not available.")
            return

        stats = await self.data.pg_storage.query_top_nodes(hours=hours, limit=5)
        if not stats:
            await ctx.send("No leaderboard data available yet.")
            return

        base_url = self.config.get('server', {}).get('base_url', '').rstrip('/')

        async def resolve_name(node_id: str) -> str:
            node = self.data.nodes.get(node_id)
            if not node and self.data.pg_storage:
                node = await self.data.pg_storage.query_node_by_id(node_id)
            if node:
                name = node.get("longname") or node.get("shortname")
                if name and name not in ("Unknown", "UNK"):
                    if base_url:
                        return f"[{name}]({base_url}/nodes?node={node_id})"
                    return name
            return f"!{node_id}"

        embed = discord.Embed(
            title=f"Mesh Leaderboard \u2014 {label}",
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

        here_i_am = stats.get("here_i_am", [])
        if here_i_am:
            lines = []
            for i, row in enumerate(here_i_am):
                name = await resolve_name(row["node_id"])
                lines.append(f"{medals[i]} {name} \u2014 **{row['count']}** updates")
            embed.add_field(name="\U0001f4cd Here I Am", value="\n".join(lines), inline=False)

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

        embed.set_footer(text=f"Timeframe: {label} | Use /topnodes 7d for weekly")
        await ctx.send(embed=embed)

    @commands.hybrid_command(name="meshinfo", description="Show all available bot commands")
    async def meshinfo_help(self, ctx):
        base_url = self.config.get('server', {}).get('base_url', '').rstrip('/')
        embed = discord.Embed(
            title="MeshInfo Bot Commands",
            url=base_url or None,
            color=discord.Color.blue(),
        )
        embed.add_field(
            name="General",
            value=(
                "`/lookup` — Look up a node by name, hex ID, or integer ID\n"
                "`/mesh` — View mesh network info and node counts\n"
                "`/whereis` — Show a node's last known position on a map\n"
                "`/topnodes` — Mesh leaderboard and achievements\n"
                "`/ping` — Check bot latency\n"
                "`/uptime` — MeshInfo server uptime\n"
                "`/meshinfo` — This help message"
            ),
            inline=False,
        )
        embed.add_field(
            name="Node Linking",
            value=(
                "`/linknode` — Link a mesh node to your Discord account\n"
                "`/unlinknode` — Remove a node link\n"
                "`/mylinkednodes` — See all your linked nodes"
            ),
            inline=False,
        )
        embed.add_field(
            name="Moderator",
            value=(
                "`/addtracker` / `/removetracker` — Manage position tracking\n"
                "`/addballoon` / `/removeballoon` — Manage balloon tracking\n"
                "`/bannode` / `/unbannode` — Manage bridge bans\n"
                "`/listtrackers` — View all tracked nodes\n"
                "`/listbans` — View all banned nodes"
            ),
            inline=False,
        )
        embed.set_footer(text="All node commands support autocomplete — start typing a name!")
        await ctx.send(embed=embed, ephemeral=True)

    @commands.hybrid_command(name="whereis", description="Show a node's last known position")
    async def whereis(self, ctx, *, flags: LookupFlags):
        search = flags.node.strip().lower().replace("!", "")
        if not search:
            await ctx.send("Please provide a node ID or name.")
            return

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

        # Check in-memory
        if id_hex and id_hex in self.data.nodes:
            node = self.data.nodes[id_hex]
        else:
            for node_id, n in self.data.nodes.items():
                if (str(n.get('shortname', '')).lower() == search or
                        str(n.get('longname', '')).lower() == search):
                    node = n
                    id_hex = node_id
                    break

        # Fall back to PostgreSQL
        if node is None and self.data.pg_storage:
            if id_hex:
                node = await self.data.pg_storage.query_node_by_id(id_hex)
            if node is None:
                results = await self.data.pg_storage.query_nodes_filtered(
                    days_limit=None, shortname_filter=search,
                )
                if not results:
                    results = await self.data.pg_storage.query_nodes_filtered(
                        days_limit=None, longname_filter=search,
                    )
                if results:
                    id_hex, node = next(iter(results.items()))

        if node is None:
            await ctx.send(f"Node `{flags.node}` not found.")
            return

        id_hex = node.get('id', id_hex) or id_hex
        position = node.get('position', {})
        if not position or not position.get('latitude_i') or not position.get('longitude_i'):
            shortname = node.get('shortname', id_hex)
            await ctx.send(f"No position data available for **{shortname}**.")
            return

        lat = position['latitude_i'] / 1e7
        lon = position['longitude_i'] / 1e7
        alt = position.get('altitude')
        shortname = node.get('shortname', 'UNK')
        longname = node.get('longname', 'Unknown')
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

        # Map thumbnail
        maps_cfg = self.config.get("integrations", {}).get("discord", {}).get("bridge", {}).get("maps", {})
        provider = maps_cfg.get("provider", "none")
        if provider != "none" and base_url:
            thumbnail_url = f"{base_url}/v1/static-map?lat={lat:.6f}&lon={lon:.6f}&zoom=12"
            embed.set_image(url=thumbnail_url)

        embed.set_footer(text=f"Node: !{id_hex}")
        await ctx.send(embed=embed)
