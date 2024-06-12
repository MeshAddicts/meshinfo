import discord
from discord.ext import commands


class MainCommands(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_ready(self):
        print(f'Logged in as {self.user} (ID: {self.user.id})')
        await self.tree.sync(guild=self.guilds[0])
        print('Synced Slash Commands')

    @commands.Cog.listener()
    async def on_message(message):
        print(f'Discord: {message.channel.id}: {message.author}: {message.content}')
        if message.content.startswith('!test'):
            await message.channel.send('Test successful!')

    @commands.command()
    async def ping(self, ctx):
        await ctx.send(f'Pong! {round(self.bot.latency * 1000)}ms')

    @commands.command(
        name="lookup",
        description="Look up a node by ID",
        guild=discord.Object(id=1234910729480441947)
    )
    async def lookup_node(ctx: discord.Interaction, node_id: str):
        global nodes
        node = nodes[node_id]
        if node is None:
            await ctx.response.send_message(f"Node {node_id} not found.")
            return
        await ctx.response.send_message(f"Node {node['id']}: Short Name = {node['shortname']}, Long Name = {node['longname']}, Hardware = {node['hardware']}, Position = {node['position']}, Last Seen = {node['last_seen']}, Active = {node['active']}")
