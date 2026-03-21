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
                hardware = mesh_pb2.HardwareModel.Name(hw_int).replace("_", " ").title()
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
        embed.add_field(name="Total Nodes", value=str(total_nodes), inline=True)
        embed.add_field(name="Online Nodes", value=str(active_nodes), inline=True)
        uptime = datetime.datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - self.config['server']['start_time']
        embed.add_field(name="Server Uptime", value=f"{uptime.days}d {uptime.seconds // 3600}h {(uptime.seconds % 3600) // 60}m {uptime.seconds % 60}s", inline=False)
        embed.set_footer(text=f"MeshInfo | {base_url}")
        await ctx.send(embed=embed)

    @commands.hybrid_command(name="ping", description="Ping the bot")
    async def ping(self, ctx):
        await ctx.send(f'Pong! {round(self.bot.latency * 1000)}ms')

    @commands.hybrid_command(name="uptime", description="Uptime of MeshInfo instance")
    async def uptime(self, ctx):
        now = datetime.datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
        uptime = now - self.config['server']['start_time']
        await ctx.send(f'MeshInfo uptime: {uptime.days}d {uptime.seconds // 3600}h {(uptime.seconds % 3600) // 60}m {uptime.seconds % 60}s')
