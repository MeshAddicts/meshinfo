#!/usr/bin/env python3

import datetime
import json
from zoneinfo import ZoneInfo
from jinja2 import Environment, FileSystemLoader

from encoders import _JSONEncoder

class DataRenderer:
  def __init__(self, config, nodes, chat, telemetry, traceroutes):
    self.config = config
    self.nodes = nodes
    self.chat = chat
    self.telemetry = telemetry
    self.traceroutes = traceroutes

  def render(self):
    self.save_file(self.chat, "chat.json")
    print(f"Saved {len(self.chat['channels']['0']['messages'])} chat messages to file ({self.config['paths']['data']}/chat.json)")

    old_nodes = nodes
    nodes = {}
    for id, node in old_nodes.items():
        if id.startswith('!'):
            id = id.replace('!', '')
        nodes[id] = node

    self.save_file(nodes, "nodes.json")
    print(f"Saved {len(nodes)} nodes to file ({self.config['paths']['data']}/nodes.json)")

    self.save_file(self.telemetry, "telemetry.json")
    print(f"Saved {len(self.telemetry)} telemetry to file ({self.config['paths']['data']}/telemetry.json)")

    self.save_file(self.traceroutes, "traceroutes.json")
    print(f"Saved {len(self.traceroutes)} traceroutes to file ({self.config['paths']['data']}/traceroutes.json)")

  def save_file(self, filename, data):
    with open(f"{self.config['paths']['data']}/{filename}", "w", encoding='utf-8') as f:
      json.dump(data, f, indent=2, sort_keys=True, cls=_JSONEncoder)
