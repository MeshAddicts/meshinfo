#!/usr/bin/env python3
import asyncio
import json
import logging
from encoders import _JSONEncoder

logger = logging.getLogger(__name__)


class DataRenderer:
  def __init__(self, config, data):
    self.config = config
    self.data = data

  async def render(self):
      await asyncio.to_thread(self._render)

  def _render(self):
    self.save_file("chat.json", self.data.chat)
    logger.debug("Saved %d chat messages to file (%s/chat.json)", len(self.data.chat['channels']['0']['messages']), self.config['paths']['data'])

    nodes = {}
    for id, node in self.data.nodes.items():
        if id.startswith('!'):
          id = id.replace('!', '')
        if len(id) != 8 or not all(c in '0123456789abcdefABCDEF' for c in id):
          continue
        nodes[id] = node
    self.save_file("nodes.json", nodes)
    logger.debug("Saved %d nodes to file (%s/nodes.json)", len(nodes), self.config['paths']['data'])

    self.save_file("telemetry.json", self.data.telemetry)
    logger.debug("Saved %d telemetry to file (%s/telemetry.json)", len(self.data.telemetry), self.config['paths']['data'])

    self.save_file("traceroutes.json", self.data.traceroutes)
    logger.debug("Saved %d traceroutes to file (%s/traceroutes.json)", len(self.data.traceroutes), self.config['paths']['data'])

  def save_file(self, filename, data):
    logger.debug("Saving %s", filename)
    with open(f"{self.config['paths']['data']}/{filename}", "w", encoding='utf-8') as f:
      json.dump(data, f, indent=2, sort_keys=True, cls=_JSONEncoder)