#!/usr/bin/env python3

from datetime import datetime, timedelta
import json
import os
from zoneinfo import ZoneInfo
import requests

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
    self.messages: list = []
    self.mqtt_messages: list = []
    self.mqtt_connect_time: datetime = self.config['server']['start_time']
    self.nodes: dict = {}
    self.telemetry: list = []
    self.telemetry_by_node: dict = {}
    self.traceroutes: list = []
    self.traceroutes_by_node: dict = {}

    self.data_renderer = DataRenderer(config, self)
    self.static_html_renderer = StaticHTMLRenderer(config, self)

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


  def save(self):
    save_start = datetime.now(ZoneInfo(self.config['server']['timezone']))
    last_data = self.config['server']['last_data_save'] if 'last_data_save' in self.config['server'] else self.config['server']['start_time']
    since_last_data = (save_start - last_data).total_seconds()
    last_render = self.config['server']['last_render'] if 'last_render' in self.config['server'] else self.config['server']['start_time']
    since_last_render = (save_start - last_render).total_seconds()
    last_backfill = self.config['server']['last_backfill'] if 'last_backfill' in self.config['server'] else self.config['server']['start_time']
    since_last_backfill = (save_start - last_backfill).total_seconds()
    print(f"Save (since last): data: {since_last_data} (threshhold: {self.config['server']['intervals']['data_save']}), render: {since_last_render} (threshhold: {self.config['server']['intervals']['render']}), backfill: {since_last_backfill} (threshhold: {self.config['server']['intervals']['enrich']})")

    if since_last_backfill >= self.config['server']['intervals']['enrich']:
        self.backfill_node_infos()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        print(f"Enriched in {round(end.timestamp() - save_start.timestamp(), 2)} seconds")
        self.config['server']['last_backfill'] = end

    if since_last_data >= self.config['server']['intervals']['data_save']:
        self.data_renderer.render()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        print(f"Saved json data in {round(end.timestamp() - save_start.timestamp(), 2)} seconds")
        self.config['server']['last_data_save'] = end

    if since_last_render >= self.config['server']['intervals']['render']:
        self.static_html_renderer.render()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        print(f"Rendered in {round(end.timestamp() - save_start.timestamp(), 2)} seconds")
        self.config['server']['last_render'] = end

  ### helpers

  def backfill_node_infos(self):
    nodes_needing_enrichment = {}
    for id, node in self.nodes.items():
      if 'shortname' not in node or 'longname' not in node or node['shortname'] == 'UNK' or node['longname'] == 'Unknown':
        nodes_needing_enrichment[id] = node
    print(f"Nodes needing enrichment: {len(nodes_needing_enrichment)}")
    if len(nodes_needing_enrichment) > 0:
      self.enrich_nodes(nodes_needing_enrichment)

  def enrich_nodes(self, node_to_enrich):
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
          if node_id in self.nodes:
            print(f"Enriched {node_id}")
            node = self.nodes[node_id]
            node['shortname'] = node_info['shortName']
            node['longname'] = node_info['longName']
            self.nodes[node_id] = node
      else:
          print(f"Failed to get info for {node_id}")

  def find_node_by_int_id(self, id: int):
    return self.nodes.get(utils.convert_node_id_from_int_to_hex(id), None)

  def find_node_by_hex_id(self, id: str):
    return self.nodes.get(id, None)

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
