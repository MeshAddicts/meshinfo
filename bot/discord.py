#!/usr/bin/env python3
import logging
from discord.ext import commands
import discord
from bot.cogs.main_commands import MainCommands
from bot.cogs.admin_commands import AdminCommands
from bot.cogs.mesh_bridge import MeshBridge
from data_store import DataStore

logger = logging.getLogger(__name__)


class DiscordBot(commands.Bot):
    def __init__(
        self,
        *args,
        config: dict,
        data: DataStore,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.config = config
        self.data = data
        self.synced = False

    async def on_ready(self):
        logger.info('Discord: Ready!')
        await self.wait_until_ready()
        if not self.synced:
            logger.info("Discord: Syncing commands")
            guild = discord.Object(id=self.config['integrations']['discord']['guild'])
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild = discord.Object(id=self.config['integrations']['discord']['guild']))
            self.synced = True

    async def on_message(self, message):
        logger.debug('Discord: %s: %s: %s', message.channel.id, message.author, message.content)
        if message.content.startswith('!test'):
            await message.channel.send('Test successful!')
        await self.process_commands(message)

    async def start_server(self):
        logger.info("Starting Discord Bot")
        await self.add_cog(MainCommands(self, self.config, self.data))
        await self.add_cog(AdminCommands(self, self.config, self.data))
        await self.add_cog(MeshBridge(self, self.config, self.data))
        await self.start(self.config['integrations']['discord']['token'])
        logger.info("Discord Bot Done!")