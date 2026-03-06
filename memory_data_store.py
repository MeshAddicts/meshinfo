#!/usr/bin/env python3

import asyncio
import copy
from datetime import datetime, timedelta
import glob
import json
import logging
import os
import shutil
from zoneinfo import ZoneInfo
import aiohttp

from data_renderer import DataRenderer
from encoders import _JSONDecoder
from models.node import Node
from static_html_renderer import StaticHTMLRenderer
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

    # Real-time write to Postgres if enabled (dual-write pattern)
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
    storage = self.config.get("storage", {})
    read_from = storage.get("read_from", "json")
    write_to = storage.get("write_to", [])

    # ── Deprecation warning (issue #225) ──────────────────────────────
    # This runs on every startup so operators see it in their logs.
    json_in_use = read_from == "json" or "json" in (write_to if isinstance(write_to, list) else [])
    if json_in_use:
      logger.error("=" * 70)
      logger.error("DEPRECATION: Filesystem (JSON) storage will be removed in the next version.")
      logger.error("Please migrate to PostgreSQL-only storage as soon as possible.")
      if read_from == "json":
        logger.error("  -> storage.read_from is 'json' — change to 'postgres' after migrating")
      if "json" in (write_to if isinstance(write_to, list) else []):
        logger.error("  -> storage.write_to includes 'json' — remove it, keep only ['postgres']")
      logger.error("  -> Migration guide: docker exec -it meshinfo-meshinfo-1 python3 scripts/migrate_json_to_postgres.py")
      logger.error("=" * 70)

    # If Postgres is used for writes (dual-write), initialize it even if read_from is JSON.
    if "postgres" in write_to and read_from != "postgres":
      logger.info("Postgres is enabled for writes; initializing Postgres pool/schema")
      ok = await self.pg_storage.connect()
      if ok:
        await self.pg_storage.ensure_schema()
      else:
        logger.warning("Postgres connect failed; disabling Postgres writes for this run")
        storage["write_to"] = [x for x in write_to if x != "postgres"]

    if read_from == "postgres":
      logger.info("Loading data from PostgreSQL")
      await self._load_from_postgres()
    else:
      logger.info("Loading data from JSON files")
      self._load_from_json()

  def _load_from_json(self):
    """Load data from JSON files (existing implementation)."""
    try:
      nodes = self.load_json_file(f"{self.config['paths']['data']}/nodes.json")
      if nodes is not None:
        for id, node in nodes.items():
          if id.startswith('!'):
            id = id.replace('!', '')
          if len(id) != 8: # 8 hex chars required, if not, we abandon it
             continue
          if node['active'] is None:
            node['active'] = False
          if 'last_seen' not in node:
            node['last_seen'] = None
          if 'since' not in node:
            node['since'] = None
          nodes[id] = node
        self.nodes = nodes
      logger.info("Loaded %d existing nodes from file (%s/nodes.json)", len(self.nodes), self.config['paths']['data'])
    except FileNotFoundError:
      self.nodes = {}
    if self.config['server']['node_id'] not in self.nodes:
      self.nodes[self.config['server']['node_id']] = Node.default_node(self.config['server']['node_id'])
    self.nodes['ffffffff'] = Node.default_node('ffffffff')

    try:
      nodes_overrides: dict|None = self.load_json_file(f"{self.config['paths']['data']}/nodes-overrides.json")
      if nodes_overrides is not None:
        for id, node_override in nodes_overrides.items():
          if id in self.nodes:
            logger.debug("Overriding node %s", id)
            node = self.nodes[id]
            if 'position' in node_override:
              logger.debug("Overriding node %s position", id)
              node['position'] = node_override['position']
            self.nodes[id] = node
        logger.info("Loaded %d nodes overrides from file (%s/nodes-overrides.json)", len(nodes_overrides.keys()), self.config['paths']['data'])
    except FileNotFoundError:
      pass

    try:
      chat = self.load_json_file(f"{self.config['paths']['data']}/chat.json")
      if chat is not None:
        self.chat = chat
      logger.info("Loaded %d chat messages from file (%s/chat.json)", len(self.chat['channels']['0']['messages']), self.config['paths']['data'])
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
      logger.info("Loaded %d telemetry messages from file (%s/telemetry.json)", len(self.telemetry), self.config['paths']['data'])
      logger.info("Loaded telemetry data for %d nodes", len(self.telemetry_by_node))
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
        logger.info("Loaded %d traceroutes from file (%s/traceroutes.json)", len(self.traceroutes), self.config['paths']['data'])
        logger.info("Loaded traceroutes data for %d nodes", len(self.traceroutes_by_node))
    except FileNotFoundError:
        self.traceroutes = []
        self.traceroutes_by_node = {}

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
      logger.exception("Failed to initialize PostgreSQL connection, falling back to JSON: %s", e)
      self._load_from_json()

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
    last_backup = self.config['server']['last_backup'] if 'last_backup' in self.config['server'] else self.config['server']['start_time']
    since_last_backup = (save_start - last_backup).total_seconds()
    logger.debug(
      "Save (since last): data: %s (threshold: %s), render: %s (threshold: %s), enrich: %s (threshold: %s), backup: %s (threshold: %s)",
      since_last_data, self.config['server']['intervals']['data_save'],
      since_last_render, self.config['server']['intervals']['render'],
      since_last_backfill, self.config['server']['enrich']['interval'],
      since_last_backup, self.config['server']['backups']['interval'],
    )

    # Periodic deprecation reminder (issue #225)
    storage = self.config.get("storage", {})
    save_write_to = storage.get("write_to", [])
    save_read_from = storage.get("read_from", "json")
    if save_read_from == "json" or "json" in (save_write_to if isinstance(save_write_to, list) else []):
      logger.warning(
        "DEPRECATION REMINDER: JSON storage is still in use. "
        "Migrate to PostgreSQL before the next release."
      )

    if 'enrich' in self.config['server'] and self.config['server']['enrich']['enabled']:
      if since_last_backfill >= self.config['server']['enrich']['interval']:
        await self.backfill_node_infos()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        logger.debug("Enriched in %.2f seconds", end.timestamp() - save_start.timestamp())
        self.config['server']['last_backfill'] = end

    if since_last_data >= self.config['server']['intervals']['data_save']:
        data_renderer = DataRenderer(self.config, copy.deepcopy(self))
        await data_renderer.render()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        logger.debug("Saved json data in %.2f seconds", end.timestamp() - save_start.timestamp())
        self.config['server']['last_data_save'] = end
        self.graph = self.graph_node(self.config['server']['node_id'])

    if since_last_render >= self.config['server']['intervals']['render']:
        static_html_renderer = StaticHTMLRenderer(self.config, copy.deepcopy(self))
        await static_html_renderer.render()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        logger.debug("Rendered in %.2f seconds", end.timestamp() - save_start.timestamp())
        self.config['server']['last_render'] = end

    if 'backups' in self.config['server'] and self.config['server']['backups']['enabled']:
      if since_last_backup >= self.config['server']['backups']['interval']:
        await self.backup()
        end = datetime.now(ZoneInfo(self.config['server']['timezone']))
        logger.debug("Backed up in %.2f seconds", end.timestamp() - save_start.timestamp())
        self.config['server']['last_backup'] = end

  ### helpers

  async def backup(self):
    now = f"{datetime.now(ZoneInfo(self.config['server']['timezone'])).strftime('%Y%m%d-%H%M%S')}"
    base_name = f"{self.config['paths']['backups']}/backup-{now}"
    tmp_path = f"/tmp/meshinfo/backup-{now}"

    logger.info("Backing up to %s.tar.bz2", base_name)
    os.makedirs(tmp_path, exist_ok=True)
    shutil.copytree("output/data", f"{tmp_path}/data")
    shutil.copytree("output/static-html", f"{tmp_path}/static-html")
    config_file = "config.toml" if os.path.exists("config.toml") else "config.json"
    shutil.copyfile(config_file, f"{tmp_path}/{config_file}")

    shutil.make_archive(
      base_name,
      'bztar',
      root_dir=tmp_path,
      base_dir=".",
      verbose=True)
    logger.info("Backed up to %s.tar.bz2", base_name)
    shutil.rmtree(tmp_path)

    if 'max_backups' in self.config['server']['backups'] and self.config['server']['backups']['max_backups'] > 0:
      files = glob.glob(f"{self.config['paths']['backups']}/*")
      files.sort(key=os.path.getmtime)
      logger.debug("Deleting old backups (max %d, found %d)", self.config['server']['backups']['max_backups'], len(files))
      for file in files[:-self.config['server']['backups']['max_backups']]:
        logger.debug("Deleting old backup: %s", file)
        os.remove(file)

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
    if not isinstance(id, str) or len(id) != 8:
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