#!/usr/bin/env python3

import copy
from datetime import datetime, timedelta
import json
import os
from zoneinfo import ZoneInfo
import aiohttp

from data_renderer import DataRenderer
from encoders import _JSONDecoder
from models.node import Node
from static_html_renderer import StaticHTMLRenderer
import utils

class MemoryDataStore:
  def __init__(self, config):
    self.config = config
    self.chat: dict = {}
    self.chat['channels'] = {
        '0': {
            'name': 'General',
            'messages': []
        }
    }
    self.graph: dict|None = {}
    self.messages: list = []
    self.mqtt_messages: list = []
    self.mqtt_connect_time: datetime = self.config['server']['start_time']
    self.nodes: dict = {}
    self.telemetry: list = []
    self.telemetry_by_node: dict = {}
    self.traceroutes: list = []
    self.traceroutes_by_node: dict = {}

  def update(self, key, value):
    self.__dict__[key] = value

  def update_node(self, id: str, node):
    if node['position'] is None:
      node['position'] = {}

    if self.config['integrations']['geocoding']['enabled']:
      if 'geocoded' not in node['position']:
        node['position']['geocoded'] = None
      if 'latitude_i' in node['position'] and 'longitude_i' in node['position'] and node['position']['latitude_i'] is not None and node['position']['longitude_i'] is not None:
        if node['position']['geocoded'] is None or node['position']['last_geocoding'] is None or node['position']['last_geocoding'] < datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - timedelta(minutes=60):
          geocoded = utils.geocode_position(self.config['integrations']['geocoding']['geocode.maps.co']['api_key'], node['position']['latitude_i'] / 10000000, node['position']['longitude_i'] / 10000000)
          if geocoded is not None:
            node['position']['geocoded'] = geocoded
            node['position']['last_geocoding'] = datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))

    node['active'] = True
    if 'last_seen' in node and node['last_seen'] is not None and isinstance(node['last_seen'], str):
      node['last_seen'] = datetime.fromisoformat(node['last_seen']).astimezone(ZoneInfo(self.config['server']['timezone']))
    node['since'] = datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - node['last_seen']
    node['last_seen'] = datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
    self.nodes[id] = node

  def load(self):
    try:
      nodes = self.load_json_file(f"{self.config['paths']['data']}/nodes.json")
      if nodes is not None:
        for id, node in nodes.items():
          if id.startswith('!'):
            id = id.replace('!', '')
          if node['active'] is None:
            node['active'] = False
          if 'last_seen' not in node:
            node['last_seen'] = None
          if 'since' not in node:
            node['since'] = None
          nodes[id] = node
        self.nodes = nodes
      print(f"Loaded {len(self.nodes)} existing nodes from file ({self.config['paths']['data']}/nodes.json)")
    except FileNotFoundError:
      self.nodes = {}
    if self.config['server']['node_id'] not in self.nodes:
      self.nodes[self.config['server']['node_id']] = Node.default_node(self.config['server']['node_id'])
    self.nodes['ffffffff'] = Node.default_node('ffffffff')

    try:
      chat = self.load_json_file(f"{self.config['paths']['data']}/chat.json")
      if chat is not None:
        self.chat = chat
      print(f"Loaded {len(self.chat['channels']['0']['messages'])} chat messages from file ({self.config['paths']['data']}/chat.json)")
    except FileNotFoundError:
      self.chat = {
          'channels': {
              '0': {
                'name': 'General',
                'messages': []
              }
          }
      }

    try:
      telemetry = self.load_json_file(f"{self.config['paths']['data']}/telemetry.json")
      if telemetry is not None:
        self.telemetry = telemetry
      else:
        self.telemetry = []
      if self.telemetry_by_node is None or len(self.telemetry_by_node) == 0:
        self.telemetry_by_node = {}
      for msg in self.telemetry:
        id = msg['from']
        if id not in self.telemetry_by_node:
          self.telemetry_by_node[id] = []
        self.telemetry_by_node[id].insert(0, msg)
      print(f"Loaded {len(self.telemetry)} telemetry messages from file ({self.config['paths']['data']}/telemetry.json)")
      print(f"Loaded telemetry data for {len(self.telemetry_by_node)} nodes")
    except FileNotFoundError:
      self.telemetry = []
      self.telemetry_by_node = {}

    try:
        traceroutes = self.load_json_file(f"{self.config['paths']['data']}/traceroutes.json")
        if traceroutes is not None:
          self.traceroutes = traceroutes
        else:
          self.traceroutes = []
        if self.traceroutes_by_node is None or len(self.traceroutes_by_node) == 0:
          self.traceroutes_by_node = {}
        for msg in self.traceroutes:
          id = msg['from']
          if id not in self.traceroutes_by_node:
            self.traceroutes_by_node[id] = []
          self.traceroutes_by_node[id].insert(0, msg)
        print(f"Loaded {len(self.traceroutes)} traceroutes from file ({self.config['paths']['data']}/traceroutes.json)")
        print(f"Loaded traceroutes data for {len(self.traceroutes_by_node)} nodes")
    except FileNotFoundError:
        self.traceroutes = []
        self.traceroutes_by_node = {}

  def load_json_file(self, filename):
    if os.path.exists(filename):
        with open(filename, "r", encoding='utf-8') as f:
            n = json.load(f, cls=_JSONDecoder)
            return n
    else:
        return None


  async def save(self):
    save_start = datetime.now(ZoneInfo(self.config['server']['timezone']))
    last_data = self.config['server']['last_data_save'] if 'last_data_save' in self.config['server'] else self.config['server']['start_time']
    since_last_data = (save_start - last_data).total_seconds()
    last_render = self.config['server']['last_render'] if 'last_render' in self.config['server'] else self.config['server']['start_time']
    since_last_render = (save_start - last_render).total_seconds()
    last_backfill = self.config['server']['last_backfill'] if 'last_backfill' in self.config['server'] else self.config['server']['start_time']
    since_last_backfill = (save_start - last_backfill).total_seconds()
    print(f"Save (since last): data: {since_last_data} (threshhold: {self.config['server']['intervals']['data_save']}), render: {since_last_render} (threshhold: {self.config['server']['intervals']['render']}), backfill: {since_last_backfill} (threshhold: {self.config['server']['enrich']['interval']})")

    if self.config['server']['enrich']['enabled'] and since_last_backfill >= self.config['server']['enrich']['interval']:
        await self.backfill_node_infos()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        print(f"Enriched in {round(end.timestamp() - save_start.timestamp(), 2)} seconds")
        self.config['server']['last_backfill'] = end

    if since_last_data >= self.config['server']['intervals']['data_save']:
        data_renderer = DataRenderer(self.config, copy.deepcopy(self))
        await data_renderer.render()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        print(f"Saved json data in {round(end.timestamp() - save_start.timestamp(), 2)} seconds")
        self.config['server']['last_data_save'] = end
        self.graph = self.graph_node(self.config['server']['node_id'])

    if since_last_render >= self.config['server']['intervals']['render']:
        static_html_renderer = StaticHTMLRenderer(self.config, copy.deepcopy(self))
        await static_html_renderer.render()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        print(f"Rendered in {round(end.timestamp() - save_start.timestamp(), 2)} seconds")
        self.config['server']['last_render'] = end

  ### helpers

  async def backfill_node_infos(self):
    nodes_needing_enrichment = {}
    for id, node in self.nodes.items():
      if 'shortname' not in node or 'longname' not in node or node['shortname'] == 'UNK' or node['longname'] == 'Unknown':
        nodes_needing_enrichment[id] = node
    print(f"Nodes needing enrichment: {len(nodes_needing_enrichment)}")
    if len(nodes_needing_enrichment) > 0:
      await self.enrich_nodes(nodes_needing_enrichment)

  async def enrich_nodes(self, node_to_enrich):
    async with aiohttp.ClientSession() as session:
        node_ids = list(node_to_enrich.keys())
        print(f"Enriching nodes: {','.join(node_ids)}")
        if self.config['server']['enrich']['provider'] == 'bayme':
          for node_id in node_ids:
            print(f"Enriching {node_id}")
            url = f"https://data.bayme.sh/api/node/infos?ids={node_id}"
            async with session.get(url) as response:
              # print(f"Response code: {response.status_code}")
              if response.status == 200:
                data = await response.json()
                for node_id, node_info in data.items():
                  print(f"Got info for {node_id}")
                  if node_id in self.nodes:
                    print(f"Enriched {node_id}")
                    node = self.nodes[node_id]
                    node['shortname'] = node_info['shortName']
                    node['longname'] = node_info['longName']
                    self.nodes[node_id] = node
              else:
                  print(f"Failed to get info for {node_id}")
        elif self.config['server']['enrich']['provider'] == 'world.meshinfo.network':
          url = f"https://world.meshinfo.network/api/v1/nodes?ids={node_ids}"
          async with session.get(url) as response:
            if response.status == 200:
              data = await response.json()
              for node_id, node_info in data.items():
                print(f"Got info for {node_id}")
                if node_id in self.nodes:
                  print(f"Enriched {node_id}")
                  node = self.nodes[node_id]
                  node['shortname'] = node_info['shortName']
                  node['longname'] = node_info['longName']
                  self.nodes[node_id] = node
            else:
                print(f"Failed to get info for {node_ids}")

  def find_node_by_int_id(self, id: int):
    return self.nodes.get(utils.convert_node_id_from_int_to_hex(id), None)

  def find_node_by_hex_id(self, id: str, include_neighbors: bool = False):
    n = self.nodes.get(id, None)
    if n is None:
      return None

    node = n.copy()

    if include_neighbors:
      neighbors_heard = []
      if 'neighborinfo' in node and node['neighborinfo'] is not None and  'neighbors' in node['neighborinfo'] and len(node['neighborinfo']['neighbors']) > 0:
        for neighbor in node['neighborinfo']['neighbors']:
          nn = self.find_node_by_hex_id(utils.convert_node_id_from_int_to_hex(neighbor["node_id"]), include_neighbors=False)
          if nn is not None:
            neighbors_heard.append(nn.copy())

      neighbors_heard_by = []
      for nid, n in self.nodes.items():
        if 'neighborinfo' in n and n['neighborinfo'] is not None and 'neighbors' in n['neighborinfo'] and len(n['neighborinfo']['neighbors']) > 0:
          if id in n['neighborinfo']['neighbors']:
            nn = self.find_node_by_hex_id(utils.convert_node_id_from_int_to_hex(nid), include_neighbors=False)
            if nn is not None:
              neighbors_heard_by.append(nn.copy())

      node['neighbors_heard'] = neighbors_heard
      node['neighbors_heard_by'] = neighbors_heard_by
    return node

  def find_node_by_short_name(self, sn: str):
    for _id, node in self.nodes.items():
      if node['shortname'] == sn:
        return node
    return None

  def find_node_by_longname(self, ln: str):
    for _id, node in self.nodes.items():
      if node['longname'] == ln:
        return node
    return None

  def graph_node(self, node_id: str) -> dict|None:
    if self.config['debug']:
        print(f"Graphing node: {node_id}")

    visited = set()  # Set to keep track of visited nodes

    def recursive_graph_node(node_id, start_id="", level=0) -> dict|None:
        node = self.find_node_by_hex_id(node_id, include_neighbors=True)
        if node is None:
            return None

        if level > 1 and node_id in visited:
            return node  # Return the node if it has already been visited

        if self.config['debug']:
          print(f"%s - %s" % ("  " * level, node_id))

        visited.add(node_id)  # Mark the node as visited

        neighbors_heard = []
        neighbors_heard_by = []

        if node['neighborinfo'] and node['neighborinfo']['neighbors']:
            # print(f"Node {node_id} has {len(node['neighborinfo']['neighbors'])} neighbors")
            for neighbor in node['neighborinfo']['neighbors']:
                nid = utils.convert_node_id_from_int_to_hex(neighbor["node_id"])
                if start_id is not None and start_id == nid or (self.config['server']['graph']['max_depth'] is not None and level >= self.config['server']['graph']['max_depth']):
                    continue
                nn = recursive_graph_node(nid, start_id=start_id, level=level+1)
                if nn is not None:
                    neighbors_heard.append(nn.copy())

        node['neighbors_heard'] = neighbors_heard
        node['neighbors_heard_by'] = neighbors_heard_by

        return node

    return recursive_graph_node(node_id, start_id=node_id)
