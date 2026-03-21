#!/usr/bin/env python3

import asyncio
import copy
from datetime import datetime, timedelta
import logging
from zoneinfo import ZoneInfo
import aiohttp

from models.node import Node
from storage.db.postgres import PostgresStorage
import utils

logger = logging.getLogger(__name__)


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

    # Event queue for Discord bridge (MQTT -> Discord)
    self.discord_event_queue: asyncio.Queue = asyncio.Queue()

    # Initialize Postgres storage
    self.pg_storage = PostgresStorage(config)

  def __deepcopy__(self, memo):
    """
    Custom deepcopy to avoid copying non-copyable runtime objects (e.g., asyncpg buffers
    held by PostgresStorage / pools / connections). Renderers only need the in-memory
    data snapshot, not the live DB connection.
    """
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result

    for k, v in self.__dict__.items():
      # Never deepcopy PostgresStorage (it can contain asyncpg internals)
      if k == "pg_storage":
        setattr(result, k, None)
        continue

      # Skip deepcopy for asyncpg internals if they somehow land on the store
      mod = type(v).__module__
      if isinstance(mod, str) and mod.startswith("asyncpg"):
        setattr(result, k, None)
        continue

      # Skip common non-copyable runtime objects
      try:
        if isinstance(v, (asyncio.Lock, asyncio.Event, asyncio.Task, logging.Logger)):
          setattr(result, k, v)
          continue
      except Exception as exc:
        # If runtime/types differ, don't block deepcopy.
        logger.debug(
          "MemoryDataStore.__deepcopy__: isinstance() guard failed for key %r (type=%s): %s",
          k, type(v),
          exc,
          exc_info=True,
        )

      setattr(result, k, copy.deepcopy(v, memo))

    return result

  def update(self, key, value):
    self.__dict__[key] = value

  def update_node(self, id: str, node):
    n = node.copy()
    if n['position'] is None:
      n['position'] = {}

    if self.config['integrations']['geocoding']['enabled']:
      if 'geocoded' not in n['position']:
        n['position']['geocoded'] = None
      if 'latitude_i' in n['position'] and 'longitude_i' in n['position'] and n['position']['latitude_i'] is not None and n['position']['longitude_i'] is not None:
        if n['position']['geocoded'] is None or n['position']['last_geocoding'] is None or n['position']['last_geocoding'] < datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - timedelta(minutes=60):
          try:
            geocoded = utils.geocode_position(self.config['integrations']['geocoding']['geocode.maps.co']['api_key'], n['position']['latitude_i'] / 10000000, n['position']['longitude_i'] / 10000000)
            if geocoded is not None:
              n['position']['geocoded'] = geocoded
              n['position']['last_geocoding'] = datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
          except Exception as e:
            logger.warning("Failed to geocode position: %s", e)

    n['active'] = True
    if 'last_seen' in n and n['last_seen'] is not None and isinstance(n['last_seen'], str):
      n['last_seen'] = datetime.fromisoformat(n['last_seen']).astimezone(ZoneInfo(self.config['server']['timezone']))
    n['since'] = datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - n['last_seen']
    n['last_seen'] = datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
    self.nodes[id] = n

    # Real-time write to Postgres (non-blocking)
    if (
      'postgres' in self.config.get('storage', {}).get('write_to', [])
      and self.pg_storage is not None
      and getattr(self.pg_storage, "enabled", False)
      and getattr(self.pg_storage, "pool", None) is not None
    ):
      try:
        try:
          loop = asyncio.get_running_loop()
          loop.create_task(self.pg_storage.write_node(id, n))
        except RuntimeError:
          # No running loop in this thread/context
          asyncio.run(self.pg_storage.write_node(id, n))
      except Exception as e:
        logger.error("Failed to write node %s to Postgres (non-blocking): %s", id, e)

  async def load(self):
    logger.info("Loading data from PostgreSQL")
    await self._load_from_postgres()

  async def _load_from_postgres(self):
    """Initialize PostgreSQL connection and prepare postgres-backed mode."""
    try:
      ok = await self.pg_storage.connect()
      if not ok:
        raise RuntimeError("PostgreSQL connect failed")

      await self.pg_storage.ensure_schema()

      # NOTE: your current code intentionally does NOT load rows into memory.
      # If your API still reads from self.nodes/chat/telemetry, you'll get empty results.
      self.nodes = {}
      self.chat = {'channels': {'0': {'name': 'General', 'messages': []}}}
      self.telemetry = []
      self.telemetry_by_node = {}
      self.traceroutes = []
      self.traceroutes_by_node = {}

      # Ensure default nodes exist in Postgres
      default_id = self.config['server']['node_id']
      default_node = Node.default_node(default_id)
      self.nodes[default_id] = default_node
      await self.pg_storage.write_node(default_id, default_node)

      broadcast_node = Node.default_node('ffffffff')
      self.nodes['ffffffff'] = broadcast_node
      await self.pg_storage.write_node('ffffffff', broadcast_node)

      logger.info("PostgreSQL mode: Data will be queried directly from database")

    except Exception as e:
      logger.exception("Failed to initialize PostgreSQL connection: %s", e)
      raise

  async def save(self):
    save_start = datetime.now(ZoneInfo(self.config['server']['timezone']))
    last_data = self.config['server']['last_data_save'] if 'last_data_save' in self.config['server'] else self.config['server']['start_time']
    since_last_data = (save_start - last_data).total_seconds()
    last_backfill = self.config['server']['last_backfill'] if 'last_backfill' in self.config['server'] else self.config['server']['start_time']
    since_last_backfill = (save_start - last_backfill).total_seconds()
    logger.debug(
      "Save (since last): graph: %s (threshold: %s), enrich: %s (threshold: %s)",
      since_last_data, self.config['server']['intervals']['data_save'],
      since_last_backfill, self.config['server']['enrich']['interval'],
    )

    if 'enrich' in self.config['server'] and self.config['server']['enrich']['enabled']:
      if since_last_backfill >= self.config['server']['enrich']['interval']:
        await self.backfill_node_infos()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        logger.debug("Enriched in %.2f seconds", end.timestamp() - save_start.timestamp())
        self.config['server']['last_backfill'] = end

    if since_last_data >= self.config['server']['intervals']['data_save']:
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        logger.debug("Rebuilt graph in %.2f seconds", end.timestamp() - save_start.timestamp())
        self.config['server']['last_data_save'] = end
        self.graph = self.graph_node(self.config['server']['node_id'])

  ### helpers

  async def backfill_node_infos(self):
    nodes_needing_enrichment = {}
    for id, node in self.nodes.items():
      if 'shortname' not in node or 'longname' not in node or node['shortname'] == 'UNK' or node['longname'] == 'Unknown':
        nodes_needing_enrichment[id] = node
    logger.info("Nodes needing enrichment: %d", len(nodes_needing_enrichment))
    if len(nodes_needing_enrichment) > 0:
      await self.enrich_nodes(nodes_needing_enrichment)

  async def enrich_nodes(self, node_to_enrich):
    async with aiohttp.ClientSession() as session:
        node_ids = list(node_to_enrich.keys())
        logger.info("Enriching nodes: %s", ','.join(node_ids))
        if self.config['server']['enrich']['provider'] == 'bayme':
          for node_id in node_ids:
            logger.debug("Enriching %s", node_id)
            url = f"https://data.bayme.sh/api/node/infos?ids={node_id}"
            try:
              async with session.get(url) as response:
                if response.status == 200:
                  data = await response.json()
                  for node_id, node_info in data.items():
                    logger.debug("Got info for %s", node_id)
                    if node_id in self.nodes:
                      logger.debug("Enriched %s", node_id)
                      node = self.nodes[node_id]
                      node['shortname'] = node_info['shortName']
                      node['longname'] = node_info['longName']
                      self.nodes[node_id] = node
                else:
                    logger.warning("Failed to get info for %s", node_id)
            except Exception as e:
              logger.warning("Failed to get info for %s: %s", node_id, e)
        elif self.config['server']['enrich']['provider'] == 'world.meshinfo.network':
          url = f"https://world.meshinfo.network/api/v1/nodes?ids={','.join(node_ids)}"
          try:
            async with session.get(url) as response:
              if response.status == 200:
                data = await response.json()
                for node_id, node_info in data.items():
                  logger.debug("Got info for %s", node_id)
                  if node_id in self.nodes:
                    logger.debug("Enriched %s", node_id)
                    node = self.nodes[node_id]
                    node['shortname'] = node_info['shortName']
                    node['longname'] = node_info['longName']
                    self.nodes[node_id] = node
              else:
                  logger.warning("Failed to get info for %s", node_ids)
          except Exception as e:
            logger.warning("Failed to get info for %s: %s", node_ids, e)

  def find_node_by_int_id(self, id: int):
    return self.nodes.get(utils.convert_node_id_from_int_to_hex(id), None)

  def find_node_by_hex_id(self, id: str, include_neighbors: bool = False):
    if not isinstance(id, str) or len(id) != 8 or not all(c in '0123456789abcdefABCDEF' for c in id):
      return None

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
    logger.debug("Graphing node: %s", node_id)

    visited = set()  # Set to keep track of visited nodes

    def recursive_graph_node(node_id, start_id="", level=0) -> dict|None:
        node = self.find_node_by_hex_id(node_id, include_neighbors=True)
        if node is None:
            return None

        if level > 1 and node_id in visited:
            return node  # Return the node if it has already been visited

        logger.debug("%s - %s", "  " * level, node_id)

        visited.add(node_id)  # Mark the node as visited

        neighbors_heard = []
        neighbors_heard_by = []

        if node['neighborinfo'] and node['neighborinfo']['neighbors']:
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
