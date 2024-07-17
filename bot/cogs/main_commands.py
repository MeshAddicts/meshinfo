from discord.ext import commands
import discord

import utils

class LookupFlags(commands.FlagConverter):
    node_id: str = commands.flag(description='Node ID')

class MainCommands(commands.Cog):
    def __init__(self, bot, config, data):
        self.bot = bot
        self.config = config
        self.data = data

    @commands.Cog.listener()
    async def on_ready(self):
        print('Discord: Logged in')

    @commands.hybrid_command(name="lookup", description="Look up a node by ID")
    async def lookup_node(self, ctx, *, flags: LookupFlags):
        print(f"Discord: /lookup: Looking up {flags.node_id}")
        try:
            id_int = int(flags.node_id, 10)
            id_hex = utils.convert_node_id_from_int_to_hex(id_int)
        except ValueError:
            id_hex = flags.node_id

        if id_hex not in self.data.nodes:
            for node_id, node in self.data.nodes.items():
                if node['shortname'] == flags.node_id:
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
            url=f"https://svm1.meshinfo.network/node_{node['id']}.html",
            color=discord.Color.blue())
        embed.set_thumbnail(url=f"https://api.dicebear.com/9.x/bottts-neutral/svg?seed={node['id']}")
        embed.add_field(name="ID (hex)", value=id_hex, inline=True)
        embed.add_field(name="ID (int)", value=id_int, inline=True)
        embed.add_field(name="Shortname", value=node['shortname'], inline=False)
        embed.add_field(name="Hardware", value=node['hardware'], inline=False)
        embed.add_field(name="Last Seen", value=node['last_seen'], inline=False)
        embed.add_field(name="Status", value=("Online" if node['active'] else "Offline"), inline=False)
        await ctx.send(embed=embed)

    @commands.hybrid_command(name="ping", description="Ping the bot")
    async def ping(self, ctx):
        print(f"Discord: /ping: Pinged by {ctx.author}")
        await ctx.send(f'Pong! {round(self.bot.latency * 1000)}ms')
