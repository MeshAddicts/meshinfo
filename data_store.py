#!/usr/bin/env python3
"""Runtime coordinator: Postgres handle, MQTT→Discord event queue, periodic enrichment."""

import asyncio
from datetime import datetime, timedelta
import logging
from zoneinfo import ZoneInfo
import aiohttp

from models.node import Node
from storage.db.postgres import PostgresStorage
import utils

logger = logging.getLogger(__name__)


class DataStore:
  def __init__(self, config):
    self.config = config
    self.mqtt_connect_time: datetime = self.config['server']['start_time']
    # Bounded so MQTT producers shed load if the Discord consumer stalls.
    self.discord_event_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
    self.pg_storage = PostgresStorage(config)

  def update(self, key, value):
    self.__dict__[key] = value

  async def update_node(self, id: str, node):
    """Apply geocoding + freshness fields, persist to Postgres, refresh the cache."""
    n = node.copy()
    if n.get('position') is None:
      n['position'] = {}

    # Geocode positions at most once an hour per node.
    if self.config['integrations']['geocoding']['enabled']:
      pos = n['position']
      if 'geocoded' not in pos:
        pos['geocoded'] = None
      lat_i = pos.get('latitude_i')
      lon_i = pos.get('longitude_i')
      last_geo = pos.get('last_geocoding')
      # Normalize ISO-string last_geocoding (from DB) to datetime for comparison.
      if isinstance(last_geo, str):
        try:
          last_geo = datetime.fromisoformat(last_geo).astimezone(ZoneInfo(self.config['server']['timezone']))
        except ValueError:
          last_geo = None
      if lat_i is not None and lon_i is not None:
        if pos['geocoded'] is None or last_geo is None or last_geo < datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - timedelta(minutes=60):
          try:
            # geocode_position uses blocking `requests.get` with a 5 s timeout; running it
            # inline stalled the entire asyncio loop (MQTT ingest, API, Discord) on every
            # position from a new-or-stale-geocode node. Offload to a worker thread.
            geocoded = await asyncio.to_thread(
              utils.geocode_position,
              self.config['integrations']['geocoding']['geocode.maps.co']['api_key'],
              lat_i / 10000000,
              lon_i / 10000000,
            )
            if geocoded is not None:
              pos['geocoded'] = geocoded
              pos['last_geocoding'] = datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
          except Exception as e:
            logger.warning("Failed to geocode position: %s", e)

    # Any update reactivates the node, so a previously-pruned node comes back online.
    # Any packet reactivates the node.
    n['active'] = True
    if isinstance(n.get('last_seen'), str):
      n['last_seen'] = datetime.fromisoformat(n['last_seen']).astimezone(ZoneInfo(self.config['server']['timezone']))
    now_local = datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))
    if isinstance(n.get('last_seen'), datetime):
      n['since'] = now_local - n['last_seen']
    n['last_seen'] = now_local

    if self.pg_storage is not None and getattr(self.pg_storage, "enabled", False) and getattr(self.pg_storage, "pool", None) is not None:
      try:
        await self.pg_storage.write_node(id, n)
        # Refresh cache only after a confirmed write.
        self.pg_storage.cache_node_set(id, n)
      except Exception as e:
        logger.error("Failed to write node %s to Postgres: %s", id, e)

  async def load(self):
    logger.info("Loading data from PostgreSQL")
    await self._load_from_postgres()

  async def _load_from_postgres(self):
    """Open the pool, run migrations, and seed the local + broadcast node rows."""
    try:
      ok = await self.pg_storage.connect()
      if not ok:
        raise RuntimeError("PostgreSQL connect failed")

      await self.pg_storage.ensure_schema()

      default_id = self.config['server']['node_id']
      default_node = Node.default_node(default_id)
      await self.pg_storage.write_node(default_id, default_node)
      self.pg_storage.cache_node_set(default_id, default_node)

      broadcast_node = Node.default_node('ffffffff')
      await self.pg_storage.write_node('ffffffff', broadcast_node)
      self.pg_storage.cache_node_set('ffffffff', broadcast_node)

      logger.info("PostgreSQL mode: data is queried directly from the database")

    except Exception as e:
      logger.exception("Failed to initialize PostgreSQL connection: %s", e)
      raise

  ### helpers

  async def backfill_node_infos(self):
    nodes_needing_enrichment = await self.pg_storage.find_nodes_needing_enrichment(limit=200)
    logger.info("Nodes needing enrichment: %d", len(nodes_needing_enrichment))
    if nodes_needing_enrichment:
      await self.enrich_nodes(nodes_needing_enrichment)

  async def enrich_nodes(self, node_to_enrich):
    async with aiohttp.ClientSession() as session:
        node_ids = list(node_to_enrich.keys())
        logger.debug("Enriching nodes: %s", ','.join(node_ids))
        if self.config['server']['enrich']['provider'] == 'bayme':
          for node_id in node_ids:
            logger.debug("Enriching %s", node_id)
            url = f"https://data.bayme.sh/api/node/infos?ids={node_id}"
            try:
              async with session.get(url) as response:
                if response.status == 200:
                  data = await response.json()
                  for nid, info in data.items():
                    await self._apply_enrichment(nid, info)
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
                for nid, info in data.items():
                  await self._apply_enrichment(nid, info)
              else:
                  logger.warning("Failed to get info for %d nodes: HTTP %d", len(node_ids), response.status)
          except Exception as e:
            logger.warning("Failed to get info for %d nodes: %s", len(node_ids), e)

  async def _apply_enrichment(self, node_id: str, info: dict):
    short = info.get('shortName')
    long_ = info.get('longName')
    if not short and not long_:
      return
    node = await self.pg_storage.get_node_cached(node_id)
    if node is None:
      return
    # Bypass update_node to avoid touching active/last_seen on a name lookup.
    if short:
      node['shortname'] = short
    if long_:
      node['longname'] = long_
    logger.debug("Enriched %s", node_id)
    try:
      await self.pg_storage.write_node(node_id, node)
      self.pg_storage.cache_node_set(node_id, node)
    except Exception as e:
      logger.error("Failed to write enrichment for %s: %s", node_id, e)
