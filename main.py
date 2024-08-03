#!/usr/bin/env python3

import asyncio
import datetime
from zoneinfo import ZoneInfo
import os
import discord
from dotenv import load_dotenv

from api import api
from bot import discord as discord_bot
from config import Config
from memory_data_store import MemoryDataStore
from mqtt import MQTT

load_dotenv()

config = Config.load()
data = MemoryDataStore(config)
data.update('mqtt_connect_time', datetime.datetime.now(ZoneInfo(config['server']['timezone'])))

async def main():
    global config
    global data

    # output app banner from file banner
    banner = open('banner', 'r').read()
    print(banner)

    if not os.path.exists(config['paths']['output']):
        os.makedirs(config['paths']['output'])
    if not os.path.exists(config['paths']['data']):
        os.makedirs(config['paths']['data'])

    os.environ['TZ'] = config['server']['timezone']

    data.load()
    await data.save()
    await data.backup()

    async with asyncio.TaskGroup() as tg:
        loop = asyncio.get_event_loop()
        api_server = api.API(config, data)
        tg.create_task(api_server.serve(loop))
        if config['broker']['enabled'] is True:
            mqtt = MQTT(config, data)
            tg.create_task(mqtt.connect())
        if config['integrations']['discord']['enabled'] is True:
            bot = discord_bot.DiscordBot(command_prefix="!", intents=discord.Intents.all(), config=config, data=data)
            tg.create_task(bot.start_server())

if __name__ == "__main__":
    asyncio.run(main())
