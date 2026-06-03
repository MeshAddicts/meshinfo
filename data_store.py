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

# Named provider presets (none shipped — configure explicitly).
_PROVIDER_PRESETS: dict = {}

# Dead legacy names dropped with a warning so stale configs still start.
_DEAD_LEGACY_PROVIDERS: dict = {
    "world.meshinfo.network": "upstream service is gone — use a Meshview entry",
    "bayme": "data.bayme.sh was never valid — use kind=\"meshview\" pointed at "
             "https://meshview.bayme.sh/api/nodes",
}

_PER_REQUEST_DELAY_SEC = 0.1
_REQUEST_TIMEOUT_SEC = 10.0
# Safety cap on a Meshview bulk /api/nodes body so one huge response can't blow up memory.
_MESHVIEW_BULK_MAX_BYTES = 50 * 1024 * 1024
# Stop hammering a provider after N consecutive failures in one cycle; resets next cycle.
_PROVIDER_FAIL_THRESHOLD = 10


def _resolve_providers(config) -> list:
  """Resolve config.server.enrich.providers (or legacy 'provider') into a runtime list.

  Accepts dicts (Meshview bulk or MeshInfo URL template) and bare URL templates.
  Dead legacy names are dropped with a warning.
  """
  cfg = config.get('server', {}).get('enrich', {}) or {}
  raw = cfg.get('providers')
  if raw is None and cfg.get('provider') is not None:
    raw = [cfg['provider']]
  if not raw:
    return []
  result = []
  for entry in raw:
    if isinstance(entry, str):
      if entry in _DEAD_LEGACY_PROVIDERS:
        logger.warning(
          "server.enrich provider %r is no longer reachable; %s",
          entry, _DEAD_LEGACY_PROVIDERS[entry],
        )
        continue
      preset = _PROVIDER_PRESETS.get(entry)
      if preset is None:
        # Bare URLs with an {ids} placeholder are generic templates.
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
      kind = entry.get("kind", "meshinfo")
      url = entry["url"]
      if kind == "meshview":
        # Bulk fetch + local filter; no {ids} placeholder needed.
        try:
          days_active = int(entry.get("days_active", 7))
        except (TypeError, ValueError):
          logger.warning("Enrichment provider %r has invalid days_active %r; using 7",
                         entry.get("name", url), entry.get("days_active"))
          days_active = 7
        result.append({
          "name": entry.get("name", url),
          "kind": "meshview",
          "url": url,
          "days_active": days_active,
        })
      elif kind == "meshinfo":
        if "{ids}" not in url:
          logger.warning("Enrichment provider %r is missing {ids} placeholder; skipping", entry.get("name", url))
          continue
        result.append({
          "name": entry.get("name", url),
          "url_template": url,
          "single_id_per_request": bool(entry.get("single_id_per_request", False)),
        })
      else:
        logger.warning("Unknown enrichment provider kind %r; skipping", kind)
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
    # Isolate position from the caller's dict — geocoding mutates pos in place
    # and we'd otherwise leak enriched fields into the raw mqtt_messages log.
    if n.get('position') is None:
      n['position'] = {}
    else:
      n['position'] = dict(n['position'])

    # Geocode positions at most once an hour per node.
    if self.config['integrations']['geocoding']['enabled']:
      pos = n['position']
      if 'geocoded' not in pos:
        pos['geocoded'] = None
      lat_i = pos.get('latitude_i')
      lon_i = pos.get('longitude_i')
      last_geo = pos.get('last_geocoding')
      # DB rows arrive as ISO strings; normalize for comparison.
      if isinstance(last_geo, str):
        try:
          last_geo = datetime.fromisoformat(last_geo).astimezone(ZoneInfo(self.config['server']['timezone']))
        except ValueError:
          last_geo = None
      if lat_i is not None and lon_i is not None:
        if pos['geocoded'] is None or last_geo is None or last_geo < datetime.now().astimezone(ZoneInfo(self.config['server']['timezone'])) - timedelta(minutes=60):
          try:
            # geocode_position is sync (requests.get); offload so it doesn't block the event loop.
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

    # Any packet reactivates a pruned node.
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
    """Query every configured enrichment provider for the current set of unknown nodes."""
    ids_needing_enrichment = await self.pg_storage.find_nodes_needing_enrichment()
    if not ids_needing_enrichment:
      return
    logger.info("Nodes needing enrichment: %d", len(ids_needing_enrichment))
    await self.enrich_nodes(ids_needing_enrichment)

  async def enrich_nodes(self, node_ids_to_enrich):
    """Iterate providers in order, asking each for the still-unknown ids."""
    providers = _resolve_providers(self.config)
    if not providers:
      logger.debug("No enrichment providers configured")
      return
    pending: set = set(node_ids_to_enrich)
    timeout = aiohttp.ClientTimeout(total=_REQUEST_TIMEOUT_SEC)
    async with aiohttp.ClientSession(timeout=timeout) as session:
      for prov in providers:
        if not pending:
          break
        before_count = len(pending)
        if prov.get("kind") == "meshview":
          result = await self._enrich_via_meshview_bulk(session, prov, pending)
        else:
          result = await self._enrich_via_provider(session, prov, sorted(pending))
        # One log line per provider per cycle. WARNING when the provider looks
        # unreachable (0/N succeeded or circuit-breaker fired), INFO otherwise.
        attempted = result["attempted"]
        succeeded = result["succeeded"]
        named = result["named"]
        aborted = result["aborted"]
        if attempted > 0 and succeeded == 0:
          logger.warning(
            "%s: 0/%d requests succeeded — upstream may be unreachable",
            prov["name"], attempted,
          )
        elif aborted:
          logger.warning(
            "%s: aborted after %d consecutive failures; named %d of %d (%d/%d requests sent succeeded)",
            prov["name"], _PROVIDER_FAIL_THRESHOLD, len(named), before_count, succeeded, attempted,
          )
        elif succeeded < attempted:
          logger.info(
            "%s: named %d of %d node(s); %d/%d requests succeeded",
            prov["name"], len(named), before_count, succeeded, attempted,
          )
        elif attempted > 0:
          logger.info(
            "%s: named %d of %d node(s)",
            prov["name"], len(named), before_count,
          )
        pending -= named
    if pending:
      logger.debug("After all providers, %d node(s) remain unnamed", len(pending))

  async def _enrich_via_provider(self, session, prov: dict, node_ids: list) -> dict:
    """Query one provider for the given ids.

    Returns {named, attempted, succeeded, aborted}. `aborted` is set when the
    circuit breaker trips so the caller can distinguish "unreachable" from
    "responded but didn't know any of our nodes".
    """
    named: set = set()
    attempted = 0
    succeeded = 0
    consecutive_failures = 0
    aborted = False
    if prov["single_id_per_request"]:
      # Provider rejects multi-id requests; iterate, paced so we don't hammer it.
      for node_id in node_ids:
        attempted += 1
        data = await self._fetch_provider(session, prov, [node_id])
        if data is not None:
          succeeded += 1
          consecutive_failures = 0
          for nid, info in data.items():
            if await self._apply_enrichment(nid, info):
              named.add(nid)
        else:
          consecutive_failures += 1
          if consecutive_failures >= _PROVIDER_FAIL_THRESHOLD:
            aborted = True
            break
        await asyncio.sleep(_PER_REQUEST_DELAY_SEC)
    else:
      # Generic MeshInfo template — comma-join into one call.
      attempted = 1
      data = await self._fetch_provider(session, prov, node_ids)
      if data is not None:
        succeeded = 1
        for nid, info in data.items():
          if await self._apply_enrichment(nid, info):
            named.add(nid)
    return {"named": named, "attempted": attempted, "succeeded": succeeded, "aborted": aborted}

  async def _fetch_provider(self, session, prov: dict, ids: list) -> dict | None:
    """One GET against `prov`. Returns the parsed JSON dict, or None on any failure."""
    # str.replace rather than .format — operator-supplied URLs may have stray
    # `{...}` braces that would trip str.format's placeholder parser.
    url = prov["url_template"].replace("{ids}", ",".join(ids))
    try:
      async with session.get(url) as response:
        if response.status == 200:
          return await response.json()
        logger.debug("%s: HTTP %d for %d id(s)", prov["name"], response.status, len(ids))
    except Exception as e:
      logger.debug("%s: request failed for %d id(s): %s", prov["name"], len(ids), e)
    return None

  async def _enrich_via_meshview_bulk(self, session, prov: dict, pending: set) -> dict:
    """One bulk GET against a Meshview /api/nodes; filter locally.
    Cheaper than per-id requests when many unknowns are covered by one response."""
    named: set = set()
    sep = "&" if "?" in prov["url"] else "?"
    url = f"{prov['url']}{sep}days_active={prov['days_active']}"
    try:
      async with session.get(url) as response:
        if response.status != 200:
          logger.debug("%s: HTTP %d", prov["name"], response.status)
          return {"named": named, "attempted": 1, "succeeded": 0, "aborted": False}
        # Bound memory: skip a pathologically large bulk body rather than load it.
        clen = getattr(response, "content_length", None)
        if clen is not None and clen > _MESHVIEW_BULK_MAX_BYTES:
          logger.warning("%s: bulk response too large (%d bytes); skipping", prov["name"], clen)
          return {"named": named, "attempted": 1, "succeeded": 0, "aborted": False}
        data = await response.json()
    except Exception as e:
      logger.debug("%s: bulk fetch failed: %s", prov["name"], e)
      return {"named": named, "attempted": 1, "succeeded": 0, "aborted": False}
    # Meshview gives node_id as uint32 decimal + snake_case names; adapt to our shape.
    lookup: dict = {}
    for node in (data.get("nodes") or []):
      nid = utils.normalize_node_id(node.get("node_id"))
      if nid is None:
        continue
      long_ = (node.get("long_name") or "").strip()
      short = (node.get("short_name") or "").strip()
      if long_ or short:
        lookup[nid] = {"longName": long_, "shortName": short}
    for nid in list(pending):
      info = lookup.get(nid)
      if info is None:
        continue
      if await self._apply_enrichment(nid, info):
        named.add(nid)
    return {"named": named, "attempted": 1, "succeeded": 1, "aborted": False}

  async def _apply_enrichment(self, node_id: str, info: dict) -> bool:
    """Write enriched name fields direct to Postgres + cache; returns True if applied.
    Bypasses update_node so a name lookup doesn't bump last_seen or active."""
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
