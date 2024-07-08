#!/usr/bin/env python3

import datetime
import json
from zoneinfo import ZoneInfo
import os
from jinja2 import Environment, FileSystemLoader
from dotenv import load_dotenv
import requests

from config import Config
from encoders import _JSONDecoder, _JSONEncoder
from memory_data_store import MemoryDataStore
from meshtastic import HardwareModel
from models.node import Node
import geo
from mqtt import MQTT
import utils

load_dotenv()

config = Config.load()
data = MemoryDataStore(config)
data.update('mqtt_connect_time', datetime.datetime.now(ZoneInfo(config['server']['timezone'])))

def find_node_by_int_id(id: int):
    return nodes.get(utils.convert_node_id_from_int_to_hex(id), None)

def find_node_by_hex_id(id: str):
    return nodes.get(id, None)

def find_node_by_short_name(sn: str):
    for _id, node in nodes.items():
        if node['shortname'] == sn:
            return node
    return None

def prune_expired_nodes():
    global config
    global nodes

    now = datetime.datetime.now(ZoneInfo(config['server']['timezone']))
    ids_to_delete: list[str] = []
    for id, node in nodes.items():
        last_seen = datetime.datetime.fromisoformat(node['last_seen']).astimezone() if isinstance(node['last_seen'], str) else node['last_seen']
        since = (now - last_seen).seconds
        if node['active'] and since >= config['server']['node_activity_prune_threshold']:
            ids_to_delete.append(node['id'])
            print(f"Node {id} pruned (last heard {since} seconds ago)")
    for id in ids_to_delete:
        nodes[id]['active'] = False

def load_nodes_from_file():
    n = {}
    if os.path.exists("output/data/nodes.json"):
        with open("output/data/nodes.json", "r", encoding='utf-8') as f:
            n = json.load(f, cls=_JSONDecoder)
    return n

def backfill_node_infos():
    global nodes

    # get nodes that need shortname and longname
    nodes_needing_enrichment = {}
    for id, node in nodes.items():
        if 'shortname' not in node or 'longname' not in node or node['shortname'] == 'UNK' or node['longname'] == 'Unknown':
            nodes_needing_enrichment[id] = node
    print(f"Nodes needing enrichment: {len(nodes_needing_enrichment)}")
    if len(nodes_needing_enrichment) > 0:
        enrich_nodes(nodes_needing_enrichment)

def enrich_nodes(node_to_enrich):
    global nodes

    node_ids = list(node_to_enrich.keys())
    print(f"Enriching nodes: {','.join(node_ids)}")
    for node_id in node_ids:
        print(f"Enriching {node_id}")
        url = f"https://data.bayme.sh/api/node/infos?ids={node_id}"
        response = requests.get(url)
        # print(f"Response code: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            for node_id, node_info in data.items():
                print(f"Got info for {node_id}")
                if node_id in nodes:
                    print(f"Enriched {node_id}")
                    node = nodes[node_id]
                    node['shortname'] = node_info['shortName']
                    node['longname'] = node_info['longName']
                    nodes[node_id] = node
        else:
            print(f"Failed to get info for {node_id}")

def save():
    global nodes
    global chat
    global config
    global traceroutes

    save_start = datetime.datetime.now(ZoneInfo(config['server']['timezone']))
    last_data = config['server']['last_data_save'] if 'last_data_save' in config['server'] else config['server']['start_time']
    since_last_data = (save_start - last_data).total_seconds()
    last_render = config['server']['last_render'] if 'last_render' in config['server'] else config['server']['start_time']
    since_last_render = (save_start - last_render).total_seconds()
    last_backfill = config['server']['last_backfill'] if 'last_backfill' in config['server'] else config['server']['start_time']
    since_last_backfill = (save_start - last_backfill).total_seconds()
    print(f"Since last - data save: {since_last_data}, render: {since_last_render}, backfill: {since_last_backfill}")

    if since_last_backfill >= 900:
        backfill_node_infos()
        end = datetime.datetime.now(ZoneInfo(config['server']['timezone']))
        print(f"Backfilled in {round(end.timestamp() - save_start.timestamp(), 3)} seconds")
        config['server']['last_backfill'] = end

    if since_last_data >= config['server']['intervals']['data_save']:
        save_nodes_to_file()
        end = datetime.datetime.now(ZoneInfo(config['server']['timezone']))
        print(f"Saved json data in {round(end.timestamp() - save_start.timestamp(), 3)} seconds")
        config['server']['last_data_save'] = end

    if since_last_render >= config['server']['intervals']['render']:
        render_static_html_files()
        end = datetime.datetime.now(ZoneInfo(config['server']['timezone']))
        print(f"Rendered in {round(end.timestamp() - save_start.timestamp(), 3)} seconds")
        config['server']['last_render'] = end

def load():
    global config
    global data

    try:
      data.update('nodes', load_nodes_from_file())
      print(f"Loaded {len(data.nodes)} existing nodes from file ({config['paths']['data']}/nodes.json)")
    except FileNotFoundError:
      data.update('nodes', {})
    if config['server']['node_id'] not in data.nodes:
      data.nodes[config['server']['node_id']] = Node.default_node(config['server']['node_id'])
    data.nodes['ffffffff'] = Node.default_node('ffffffff')

    try:
      data.chat = load_chat_from_file("json", f"{config['paths']['data']}/chat.json")
      print(f"Loaded {len(data.chat['channels']['0']['messages'])} chat messages from file ({config['paths']['data']}/chat.json)")
    except FileNotFoundError:
      data.chat = {
          'channels': {
              '0': {
                'name': 'General',
                'messages': []
              }
          }
      }

    try:
      data.telemetry = load_from_json_file(f"{config['paths']['data']}/telemetry.json")
      if data.telemetry is None or len(data.telemetry) == 0:
        data.telemetry = []
      if data.telemetry_by_node is None or len(data.telemetry_by_node) == 0:
        data.telemetry_by_node = {}
      for msg in data.telemetry:
        id = msg['from']
        if id not in data.telemetry_by_node:
          data.telemetry_by_node[id] = []
        data.telemetry_by_node[id].insert(0, msg)
      print(f"Loaded {len(data.telemetry)} telemetry messages from file ({config['paths']['data']}/telemetry.json)")
      print(f"Loaded telemetry data for {len(data.telemetry_by_node)} nodes")
    except FileNotFoundError:
      data.telemetry = []
      data.telemetry_by_node = {}

    try:
        data.traceroutes = load_from_json_file(f"{config['paths']['data']}/traceroutes.json")
        if data.traceroutes is None or len(data.traceroutes) == 0:
          data.traceroutes = []
        if data.traceroutes_by_node is None or len(data.traceroutes_by_node) == 0:
          data.traceroutes_by_node = {}
        for msg in data.traceroutes:
          id = msg['from']
          if id not in data.traceroutes_by_node:
            data.traceroutes_by_node[id] = []
          data.traceroutes_by_node[id].insert(0, msg)
        print(f"Loaded {len(data.traceroutes)} traceroutes from file ({config['paths']['data']}/traceroutes.json)")
        print(f"Loaded traceroutes data for {len(data.traceroutes_by_node)} nodes")
    except FileNotFoundError:
        data.traceroutes = []
        data.traceroutes_by_node = {}

def load_chat_from_file(type, path, config=config):
    global chat
    if type == "json":
      with open(path, "r", encoding='utf-8') as f:
          return json.load(f, cls=_JSONDecoder)
    if type == "html":
      pass

def load_from_json_file(path, config=config):
    with open(path, "r", encoding='utf-8') as f:
        return json.load(f, cls=_JSONDecoder)

def run():
    global chat
    global config
    global nodes

    if not os.path.exists(config['paths']['output']):
        os.makedirs(config['paths']['output'])
    if not os.path.exists(config['paths']['data']):
        os.makedirs(config['paths']['data'])

    os.environ['TZ'] = config['server']['timezone']

    load()
    save()

    if os.environ.get('MQTT_BROKER') is not None:
        config['broker']['host'] = os.environ['MQTT_BROKER']
    if os.environ.get('MQTT_PORT') is not None:
        config['broker']['port'] = int(os.environ['MQTT_PORT'])
    if os.environ.get('MQTT_CLIENT_ID') is not None:
        config['broker']['client_id'] = os.environ['MQTT_CLIENT_ID']
    if os.environ.get('MQTT_TOPIC') is not None:
        config['broker']['topic'] = os.environ['MQTT_TOPIC']

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
