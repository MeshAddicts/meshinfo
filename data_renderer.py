#!/usr/bin/env python3

import asyncio
import json

from encoders import _JSONEncoder

class DataRenderer:
  def __init__(self, config, data):
    self.config = config
    self.data = data

  async def render(self):
      await asyncio.to_thread(self._render)

  def _render(self):
    self.save_file("chat.json", self.data.chat)
    print(f"Saved {len(self.data.chat['channels']['0']['messages'])} chat messages to file ({self.config['paths']['data']}/chat.json)")

    nodes = {}
    for id, node in self.data.nodes.items():
        if id.startswith('!'):
          id = id.replace('!', '')
        if len(id) != 8: # 8 hex chars required, if not, we abandon it
          continue
        nodes[id] = node

    self.save_file("nodes.json", nodes)
    print(f"Saved {len(nodes)} nodes to file ({self.config['paths']['data']}/nodes.json)")

    self.save_file("telemetry.json", self.data.telemetry, 'telemetry')

    self.save_file("traceroutes.json", self.data.traceroutes, 'traceroutes')

  def save_file(self, filename, data, settings_key=None):

    data_to_save = data

    # check settings to see if we should store this data and (if it's a list) up to how many items
    if settings_key:
      history_settings = self.config.get('history', {}).get(settings_key, {})

      if history_settings.get('store', True):
        limit = history_settings.get('storage_limit', 0)
        if isinstance(data, list) and limit > 0:
          data_to_save = data[:limit]
      else:
        print(f"Not configured to save {settings_key}")
        return

    print(f"Saving {filename}")

    with open(f"{self.config['paths']['data']}/{filename}", "w", encoding='utf-8') as f:
      json.dump(data_to_save, f, indent=2, sort_keys=True, cls=_JSONEncoder)

    if settings_key:
      print(f"Saved {len(data_to_save)} {settings_key} to file ({self.config['paths']['data']}/{filename}.json)")
