#!/usr/bin/env python3

from datetime import datetime
from zoneinfo import ZoneInfo

from static_html_renderer import StaticHTMLRenderer


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

    self.static_html_renderer = StaticHTMLRenderer(config, self)

  def update(self, key, value):
    self.__dict__[key] = value

  def update_node(self, id: str, node):
    node['active'] = True
    node['last_seen'] = datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
    self.nodes[id] = node

  def save(self):
    save_start = datetime.now(ZoneInfo(self.config['server']['timezone']))
    last_data = self.config['server']['last_data_save'] if 'last_data_save' in self.config['server'] else self.config['server']['start_time']
    since_last_data = (save_start - last_data).total_seconds()
    last_render = self.config['server']['last_render'] if 'last_render' in self.config['server'] else self.config['server']['start_time']
    since_last_render = (save_start - last_render).total_seconds()
    last_backfill = self.config['server']['last_backfill'] if 'last_backfill' in self.config['server'] else self.config['server']['start_time']
    since_last_backfill = (save_start - last_backfill).total_seconds()
    print(f"Since last - data save: {since_last_data}, render: {since_last_render}, backfill: {since_last_backfill}")

    # if since_last_backfill >= 900:
    #     self.backfill_node_infos()
    #     end = datetime.now(ZoneInfo(self.config['server']['timezone']))
    #     print(f"Backfilled in {round(end.timestamp() - save_start.timestamp(), 3)} seconds")
    #     self.config['server']['last_backfill'] = end

    # if since_last_data >= self.config['server']['intervals']['data_save']:
    #     self.save_nodes_to_file()
    #     end = datetime.now(ZoneInfo(self.config['server']['timezone']))
    #     print(f"Saved json data in {round(end.timestamp() - save_start.timestamp(), 3)} seconds")
    #     self.config['server']['last_data_save'] = end

    if since_last_render >= self.config['server']['intervals']['render']:
        self.static_html_renderer.render()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        print(f"Rendered in {round(end.timestamp() - save_start.timestamp(), 3)} seconds")
        self.config['server']['last_render'] = end
