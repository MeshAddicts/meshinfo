import datetime
from zoneinfo import ZoneInfo
from discord.ext import commands
import discord

import utils

class LookupFlags(commands.FlagConverter):
    node: str = commands.flag(description='Node')

class MainCommands(commands.Cog):
    def __init__(self, bot, config, data):
        self.bot = bot
        self.config = config
        self.data = data

    @commands.Cog.listener()
    async def on_ready(self):
        print('Discord: Logged in')

    @commands.hybrid_command(name="lookup", description="Look up a node by ID (int or hex) or short name")
    async def lookup_node(self, ctx, *, flags: LookupFlags):
        print(f"Discord: /lookup: Looking up {flags.node}")
        try:
            id_int = int(flags.node, 10)
            id_hex = utils.convert_node_id_from_int_to_hex(id_int)
        except ValueError:
            id_hex = flags.node

        if id_hex not in self.data.nodes:
            for node_id, node in self.data.nodes.items():
                if str(node['shortname']).lower() == flags.node.lower():
                    id_hex = node_id
                    break

        if id_hex not in self.data.nodes:
            print(f"Discord: /lookup: Node {id_hex} not found.")
            await ctx.send(f"Node {id_hex} not found.")
            return

        id_int = utils.convert_node_id_from_hex_to_int(id_hex)
        node = self.data.nodes[id_hex]
        print(f"Discord: /lookup: Found {node['id']}")

        embed = discord.Embed(
            title=f"Node {node['shortname']}: {node['longname']}",
            url=f"{self.config['server']['base_url'].strip('/')}/node_{node['id']}.html",
            color=discord.Color.blue())
        embed.set_thumbnail(url=f"https://api.dicebear.com/9.x/bottts-neutral/svg?seed={node['id']}")
        embed.add_field(name="ID (hex)", value=id_hex, inline=True)
        embed.add_field(name="ID (int)", value=id_int, inline=True)
        embed.add_field(name="Shortname", value=node['shortname'], inline=False)
        embed.add_field(name="Hardware", value=node['hardware'], inline=False)
        embed.add_field(name="Last Seen", value=node['last_seen'], inline=False)
        embed.add_field(name="Status", value=("Online" if node['active'] else "Offline"), inline=False)
        await ctx.send(embed=embed)

    @commands.hybrid_command(name="mesh", description="Information about the mesh")
    async def mesh_info(self, ctx):
        print(f"Discord: /mesh: Mesh info requested by {ctx.author}")
        embed = discord.Embed(
            title=f"Information about {self.config['mesh']['name']}",
            url=self.config['server']['base_url'].strip('/'),
            color=discord.Color.blue())
        embed.add_field(name="Name", value=self.config['mesh']['name'], inline=False)
        embed.add_field(name="Shortname", value=self.config['mesh']['shortname'], inline=False)
        embed.add_field(name="Description", value=self.config['mesh']['description'], inline=False)
        embed.add_field(name="Official Website", value=self.config['mesh']['url'], inline=False)
        location = f"{self.config['mesh']['metro']}, {self.config['mesh']['region']}, {self.config['mesh']['country']}"
        embed.add_field(name="Location", value=location, inline=False)
        embed.add_field(name="Timezone", value=self.config['server']['timezone'], inline=False)
        embed.add_field(name="Known Nodes", value=len(self.data.nodes), inline=True)
        embed.add_field(name="Online Nodes", value=len([n for n in self.data.nodes.values() if n['active']]), inline=True)
        uptime = datetime.datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - self.config['server']['start_time']
        embed.add_field(name="Server Uptime", value=f"{uptime.days}d {uptime.seconds // 3600}h {uptime.seconds // 60}m {uptime.seconds % 60}s", inline=False)
        embed.add_field(name="Messages Since Server Startup", value=len(self.data.messages), inline=True)
        await ctx.send(embed=embed)

    @commands.hybrid_command(name="ping", description="Ping the bot")
    async def ping(self, ctx):
        print(f"Discord: /ping: Pinged by {ctx.author}")
        await ctx.send(f'Pong! {round(self.bot.latency * 1000)}ms')

    @commands.hybrid_command(name="uptime", description="Uptime of MeshInfo instance")
    async def uptime(self, ctx):
        print(f"Discord: /uptime: Uptime requested by {ctx.author}")
        now = datetime.datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
        print(now)
        print(self.config['server']['start_time'])
        uptime = now - self.config['server']['start_time']
        print(uptime)
        print(f"{uptime.days}d {uptime.seconds // 3600}h {uptime.seconds // 60}m {uptime.seconds % 60}s")
        await ctx.send(f'MeshInfo uptime: {uptime.days}d {uptime.seconds // 3600}h {uptime.seconds // 60}m {uptime.seconds % 60}s')
