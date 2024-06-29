#!/usr/bin/env python3

import asyncio
import os
from typing import List

import discord
from discord.ext import commands
from dotenv import load_dotenv

from bot.cogs.main_commands import MainCommands


class DiscordBot(commands.Bot):
    guilds = []

    def __init__(
        self,
        *args,
        initial_guilds: List[int],
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.guilds = initial_guilds


async def main():
    load_dotenv()

    if os.environ.get("DISCORD_TOKEN") is not None:
        token = os.environ["DISCORD_TOKEN"]
        channel_id = os.environ["DISCORD_CHANNEL_ID"]
        bot = DiscordBot(
            command_prefix="!",
            intents=discord.Intents.all(),
            initial_guilds=[1234910729480441947],
        )
        print("Adding cog MainCommands")
        await bot.add_cog(MainCommands(bot))
        print("Starting bot")
        await bot.start(token)
        print("Bot started")
        await bot.get_channel(channel_id).send("Hello.")
    else:
        print("Not running bot because DISCORD_TOKEN not set")


async def start_bot():
    print("Starting Discord Bot")
    await main()
    print("Discord Bot Done!")


if __name__ == "__main__":
    asyncio.run(main(), debug=True)
