#!/usr/bin/env python3

import asyncio
from discord.ext import commands
import discord
from dotenv import load_dotenv

from bot.cogs.main_commands import MainCommands
from memory_data_store import MemoryDataStore


class DiscordBot(commands.Bot):
    def __init__(
        self,
        *args,
        config: dict,
        data: MemoryDataStore,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.config = config
        self.data = data
        self.synced = False

    async def on_ready(self):
        print('Discord: Ready!')
        await self.wait_until_ready()
        if not self.synced:
            print("Discord: Syncing commands")
            guild = discord.Object(id=self.config['integrations']['discord']['guild'])
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild = discord.Object(id=self.config['integrations']['discord']['guild']))
            self.synced = True


    async def on_message(self, message):
        print(f'Discord: {message.channel.id}: {message.author}: {message.content}')
        if message.content.startswith('!test'):
            await message.channel.send('Test successful!')
        await self.process_commands(message)

    async def start_server(self):
        print("Starting Discord Bot")
        await self.add_cog(MainCommands(self, self.config, self.data))
        await self.start(self.config['integrations']['discord']['token'])
        print("Discord Bot Done!")

async def main():
    load_dotenv()
    # if os.environ.get("DISCORD_TOKEN") is not None:
    #     token = os.environ["DISCORD_TOKEN"]
    #     channel_id = os.environ["DISCORD_CHANNEL_ID"]
    #     bot = DiscordBot(
    #         command_prefix="!",
    #         intents=discord.Intents.all(),
    #         initial_guilds=[1234910729480441947],
    #     )
    #     print("Adding cog MainCommands")
    #     await bot.add_cog(MainCommands(bot))
    #     print("Starting bot")
    #     await bot.start(token)
    #     print("Bot started")
    #     await bot.get_channel(channel_id).send("Hello.")
    # else:
    #     print("Not running bot because DISCORD_TOKEN not set")

if __name__ == "__main__":
    asyncio.run(main(), debug=True)
