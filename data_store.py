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

# Named provider presets. URL templates substitute {ids} with a comma-joined id list
# (or a single id when single_id_per_request=True). Add new presets here as their APIs
# are confirmed; users can also drop arbitrary URL templates into config.enrich.providers.
_PROVIDER_PRESETS: dict = {
    "bayme": {
        "url_template": "https://data.bayme.sh/api/node/infos?ids={ids}",
        "single_id_per_request": True,  # bayme's API rejects multi-id requests
    },
}

# Throttle within a single provider's batch so we don't hammer the upstream API.
_PER_REQUEST_DELAY_SEC = 0.1


def _resolve_providers(config) -> list:
  """Turn config.server.enrich.providers (or legacy 'provider') into a runtime list.

  Accepts entries shaped as either a preset name (e.g. "bayme") or a dict with at
  least a `url` template for a generic MeshInfo-instance endpoint. Legacy
  `provider = "world.meshinfo.network"` is silently dropped (the upstream is dead);
  legacy `provider = "bayme"` is upgraded to ["bayme"].
  """
  cfg = config.get('server', {}).get('enrich', {}) or {}
  raw = cfg.get('providers')
  if raw is None and cfg.get('provider') is not None:
    legacy = cfg['provider']
    if legacy == 'world.meshinfo.network':
      logger.warning(
        "server.enrich.provider='world.meshinfo.network' is no longer reachable; "
        "configure providers=[\"bayme\"] (or another MeshInfo URL) to re-enable enrichment"
      )
      raw = []
    else:
      raw = [legacy]
  if not raw:
    return []
  result = []
  for entry in raw:
    if isinstance(entry, str):
      preset = _PROVIDER_PRESETS.get(entry)
      if preset is None:
        # Treat bare strings that look like URLs as generic templates (with {ids} placeholder).
        if entry.startswith(('http://', 'https://')) and '{ids}' in entry:
          result.append({
            "name": entry,
            "url_template": entry,
            "single_id_per_request": False,
          })
        else:
          logger.warning("Unknown enrichment provider %r; skipping", entry)
      else:
        result.append({"name": entry, **preset})
    elif isinstance(entry, dict) and entry.get("url"):
      result.append({
        "name": entry.get("name", entry["url"]),
        "url_template": entry["url"],
        "single_id_per_request": bool(entry.get("single_id_per_request", False)),
      })
    else:
      logger.warning("Invalid enrichment provider entry %r; skipping", entry)
  return result


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
    """Query every configured enrichment provider for unknown node names.

    Unbounded: the previous limit=200 left the long tail permanently unnamed.
    The supervised enrichment_loop paces invocations between full cycles.
    """
    nodes_needing_enrichment = await self.pg_storage.find_nodes_needing_enrichment()
    if not nodes_needing_enrichment:
      return
    logger.info("Nodes needing enrichment: %d", len(nodes_needing_enrichment))
    await self.enrich_nodes(nodes_needing_enrichment)

  async def enrich_nodes(self, node_to_enrich):
    """Iterate providers, ask each for the remaining unknowns, apply what comes back."""
    providers = _resolve_providers(self.config)
    if not providers:
      logger.debug("No enrichment providers configured")
      return
    pending: set = set(node_to_enrich.keys())
    async with aiohttp.ClientSession() as session:
      for prov in providers:
        if not pending:
          break
        named = await self._enrich_via_provider(session, prov, sorted(pending))
        if named:
          logger.info("%s: enriched %d/%d unknown name(s)", prov["name"], len(named), len(pending))
        pending -= named
    if pending:
      logger.debug("After all providers, %d node(s) remain unnamed", len(pending))

  async def _enrich_via_provider(self, session, prov: dict, node_ids: list) -> set:
    """Query a single provider for the given ids; return ids it could name."""
    named: set = set()
    if prov["single_id_per_request"]:
      # bayme.sh's API only accepts one id per call. Pace requests so we don't hammer it.
      for node_id in node_ids:
        data = await self._fetch_provider(session, prov, [node_id])
        if data:
          for nid, info in data.items():
            if await self._apply_enrichment(nid, info):
              named.add(nid)
        await asyncio.sleep(_PER_REQUEST_DELAY_SEC)
    else:
      # Generic MeshInfo-instance template — comma-join the ids into one call.
      data = await self._fetch_provider(session, prov, node_ids)
      if data:
        for nid, info in data.items():
          if await self._apply_enrichment(nid, info):
            named.add(nid)
    return named

  async def _fetch_provider(self, session, prov: dict, ids: list) -> dict | None:
    """One GET against `prov`. Returns the parsed JSON dict, or None on any failure."""
    url = prov["url_template"].format(ids=",".join(ids))
    try:
      async with session.get(url) as response:
        if response.status == 200:
          return await response.json()
        logger.debug("%s: HTTP %d for %d id(s)", prov["name"], response.status, len(ids))
    except Exception as e:
      logger.debug("%s: request failed for %d id(s): %s", prov["name"], len(ids), e)
    return None

  async def _apply_enrichment(self, node_id: str, info: dict) -> bool:
    """Write enriched name fields straight to Postgres + cache. Returns True if applied.

    Bypasses update_node so a name lookup doesn't reactivate the node or bump last_seen.
    """
    short = info.get('shortName')
    long_ = info.get('longName')
    if not short and not long_:
      return False
    node = await self.pg_storage.get_node_cached(node_id)
    if node is None:
      return False
    if short:
      node['shortname'] = short
    if long_:
      node['longname'] = long_
    try:
      await self.pg_storage.write_node(node_id, node)
      self.pg_storage.cache_node_set(node_id, node)
    except Exception as e:
      logger.error("Failed to write enrichment for %s: %s", node_id, e)
      return False
    return True
