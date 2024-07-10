#!/usr/bin/env python3

import datetime
from zoneinfo import ZoneInfo
import os
from dotenv import load_dotenv

from config import Config
from memory_data_store import MemoryDataStore
from mqtt import MQTT

load_dotenv()

config = Config.load()
data = MemoryDataStore(config)
data.update('mqtt_connect_time', datetime.datetime.now(ZoneInfo(config['server']['timezone'])))

def run():
    global config
    global data

    if not os.path.exists(config['paths']['output']):
        os.makedirs(config['paths']['output'])
    if not os.path.exists(config['paths']['data']):
        os.makedirs(config['paths']['data'])

    os.environ['TZ'] = config['server']['timezone']

    data.load()
    data.save()

    if config['broker']['enabled'] is True:
        print("Connecting to MQTT broker")
        mqtt = MQTT(config, data)
        mqtt.subscribe(config['broker']['topic'])

    # discord
    # if os.environ.get('DISCORD_TOKEN') is not None:
    #     config['integrations']['discord']['token'] = os.environ['DISCORD_TOKEN']
    #     config['integrations']['discord']['channel_id'] = os.environ['DISCORD_CHANNEL_ID']
    #     config['integrations']['discord']['enabled'] = True
    #     discord_client = discord.Client(intents=discord.Intents.all())
    #     tree = app_commands.CommandTree(discord_client)

    #     @tree.command(
    #         name="lookup",
    #         description="Look up a node by ID",
    #         guild=discord.Object(id=1234910729480441947)
    #     )
    #     async def lookup_node(ctx: Interaction, node_id: str):
    #         node = nodes[node_id]
    #         if node is None:
    #             await ctx.response.send_message(f"Node {node_id} not found.")
    #             return
    #         await ctx.response.send_message(f"Node {node['id']}: Short Name = {node['shortname']}, Long Name = {node['longname']}, Hardware = {node['hardware']}, Position = {node['position']}, Last Seen = {node['last_seen']}, Active = {node['active']}")

    #     @discord_client.event
    #     async def on_ready():
    #         print(f'Discord: Logged in as {discord_client.user} (ID: {discord_client.user.id})')
    #         await tree.sync(guild=discord.Object(id=1234910729480441947))
    #         print("Discord: Synced slash commands")

    #     @discord_client.event
    #     async def on_message(message):
    #         print(f'Discord: {message.channel.id}: {message.author}: {message.content}')
    #         if message.content.startswith('!test'):
    #             await message.channel.send('Test successful!')

    #     discord_client.run(config['integrations']['discord']['token'])

if __name__ == "__main__":
    run()
