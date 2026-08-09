import asyncio
import datetime
import functools
import json
import logging
import os
import random
import re
import time
from pathlib import Path

import aiohttp
from fastapi.encoders import jsonable_encoder
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import FileResponse

from config import Config
from api.static_map import STATIC_MAP_EXECUTOR, MapUnavailableError, generate_static_map
import utils

logger = logging.getLogger(__name__)

app = FastAPI()


class TileFiles(StaticFiles):
    """StaticFiles with a cache header. Static bakes default to a 1-day TTL
    (re-bakes propagate within ~24 h); the live coverage pyramid passes
    `no-cache` so clients revalidate every use — Starlette's built-in ETag
    handling makes unchanged tiles a free 304 (the bake hardlinks untouched
    PNGs forward, preserving mtime, so their ETags are stable across bakes)."""
    def __init__(self, *args, cache_control: str = "public, max-age=86400", **kwargs):
        super().__init__(*args, **kwargs)
        self.cache_control = cache_control

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if isinstance(response, FileResponse):
            response.headers["Cache-Control"] = self.cache_control
        return response

class API:
    def __init__(self, config, data):
        self.config = config
        self.data = data

    @staticmethod
    def _coerce_node_id(raw: str) -> str:
        """Normalize a URL `{id}` path param to canonical 8-char lowercase hex.
        Accepts hex (with or without leading '!', any case, short ones padded)
        and decimal uint32. Invalid inputs pass through → 404 naturally.
        """
        # Hex first — '99005060' is a valid hex id, not a decimal to convert.
        direct = utils.normalize_node_id(raw)
        if direct:
            return direct
        try:
            return utils.normalize_node_id(int(raw)) or raw
        except (TypeError, ValueError):
            return raw

    # Membership check, not .get(): "all" maps to None on purpose; unknown -> 24h.
    _CHAT_RANGE_MAP = {"1h": 3600, "24h": 86400, "7d": 604800, "all": None}

    @classmethod
    def _chat_range_seconds(cls, value: str | None) -> int | None:
        v = value if value is not None else "24h"
        return cls._CHAT_RANGE_MAP[v] if v in cls._CHAT_RANGE_MAP else 86400

    @staticmethod
    def _parse_range(value: str | None) -> int | None:
        """Convert a range string like '1h', '24h', '7d' to seconds. Returns None for 'all' or missing, defaults invalid values to 24h."""
        DEFAULT_RANGE = 24 * 3600
        if not value:
            return None
        v = value.strip().lower()
        if v == "all":
            return None
        if v.endswith("h"):
            try:
                hours = int(v[:-1])
                return hours * 3600 if hours > 0 else DEFAULT_RANGE
            except ValueError:
                return DEFAULT_RANGE
        if v.endswith("d"):
            try:
                days = int(v[:-1])
                return days * 86400 if days > 0 else DEFAULT_RANGE
            except ValueError:
                return DEFAULT_RANGE
        return DEFAULT_RANGE

    @staticmethod
    def _parse_epoch(value: str | None) -> datetime.datetime | None:
        """Parse a unix-epoch-seconds query param into an aware UTC datetime.
        Returns None when absent or unparseable (treated as no bound)."""
        if not value:
            return None
        try:
            return datetime.datetime.fromtimestamp(int(value), tz=datetime.timezone.utc)
        except (TypeError, ValueError, OSError, OverflowError):
            return None

    @staticmethod
    def _parse_since(value: str | None) -> datetime.datetime | None:
        """Parse the /v1/nodes `since` param (unix epoch seconds, int or float)
        into an aware UTC datetime. Returns None — meaning "no delta filter",
        never an error — when absent, unparseable, non-positive, or in the
        future (a client clock ahead of ours must degrade to the full list,
        not an empty one)."""
        if not value:
            return None
        try:
            ts = float(value)
        except (TypeError, ValueError):
            return None
        # NaN/inf/negative/future all fail this chained comparison.
        if not (0 < ts <= time.time()):
            return None
        try:
            return datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
        except (ValueError, OSError, OverflowError):
            return None

    async def serve(self):
        @app.get("/")
        async def root():
            return {"status": "ok", "service": "meshinfo-api"}

        @app.get("/v1/nodes")
        async def nodes(request: Request) -> JSONResponse:
            days_to_limit = 7
            days_param = request.query_params.get("days")
            if days_param is not None:
                try:
                    days_to_limit = int(days_param)
                except ValueError:
                    return JSONResponse({"error": "days must be an integer"}, status_code=400)
            days_to_limit = max(1, days_to_limit)

            node_ids = None
            if "ids" in request.query_params.keys():
                ids_param: str|None = request.query_params.get("ids")
                if ids_param:
                    ids_param = ids_param.strip()
                    if ids_param:
                        node_ids = []
                        for id in ids_param.split(","):
                            try:
                                node_id = int(id)
                                node_id = utils.convert_node_id_from_int_to_hex(node_id)
                            except ValueError:
                                node_id = id
                            node_ids.append(node_id)

            longname_filter = None
            if "long_name" in request.query_params.keys():
                ln = request.query_params.get("long_name")
                if ln:
                    longname_filter = ln.strip()

            shortname_filter = None
            if "short_name" in request.query_params.keys():
                sn = request.query_params.get("short_name")
                if sn:
                    shortname_filter = sn.strip()

            status_filter = None
            if "status" in request.query_params.keys():
                st = request.query_params.get("status")
                if st:
                    st = st.strip()
                    if st in ["online", "offline"]:
                        status_filter = st

            # ?slim=1 omits per-node dead weight (geocoded blob, last_geocoding,
            # since) for consumers that don't read it — the SPA. Default stays
            # byte-identical for third-party consumers.
            slim = request.query_params.get("slim", "").lower() in ("1", "true", "yes")

            # ?since=<epoch seconds> narrows to nodes with last_seen >= since —
            # the SSE reconnect delta resync. Composes with days/slim; invalid
            # values fall back to the full (non-delta) response.
            since = self._parse_since(request.query_params.get("since"))

            nodes = await self.data.pg_storage.query_nodes_filtered(
                days_limit=days_to_limit,
                node_ids=node_ids,
                longname_filter=longname_filter,
                shortname_filter=shortname_filter,
                status_filter=status_filter,
                slim=slim,
                since=since,
            )

            # Wrap in JSONResponse ourselves — returning a plain dict makes
            # FastAPI run jsonable_encoder + json.dumps a second time on the
            # event loop (same applies to every /v1 handler below).
            return JSONResponse(jsonable_encoder({ "nodes": nodes, "count": len(nodes) }))

        @app.get("/v1/nodes/{id}")
        async def node(request: Request, id: str) -> JSONResponse:
            node_id = self._coerce_node_id(id)
            node_data = await self.data.pg_storage.query_node_by_id(node_id)
            if node_data:
                return JSONResponse(jsonable_encoder({ "node": node_data }))
            return JSONResponse(status_code=404, content={"error": "node not found"})

        @app.get("/v1/nodes/{id}/telemetry")
        async def node_telemetry(request: Request, id: str) -> JSONResponse:
            node_id = self._coerce_node_id(id)
            telemetry_data = await self.data.pg_storage.query_node_telemetry(node_id)
            if telemetry_data:
                return JSONResponse(jsonable_encoder({ "telemetry": telemetry_data }))
            return JSONResponse(status_code=404, content={"error": "telemetry not found"})

        @app.get("/v1/nodes/{id}/texts")
        async def node_text(request: Request, id: str) -> JSONResponse:
            node_id = self._coerce_node_id(id)
            texts = await self.data.pg_storage.query_node_texts(node_id)
            return JSONResponse(jsonable_encoder({ "texts": texts }))

        @app.get("/v1/nodes/{id}/packets")
        async def node_packets(request: Request, id: str) -> JSONResponse:
            node_id = self._coerce_node_id(id)
            try:
                limit = int(request.query_params.get("limit", 50))
            except (TypeError, ValueError):
                limit = 50
            limit = max(1, min(limit, 200))

            result = await self.data.pg_storage.query_node_mqtt_messages(
                node_id,
                limit=limit,
                start=self._parse_epoch(request.query_params.get("start")),
                end=self._parse_epoch(request.query_params.get("end")),
                before=request.query_params.get("before"),
            )
            return JSONResponse(jsonable_encoder(
                {"packets": result["messages"], "next_cursor": result["next_cursor"]}
            ))

        @app.get("/v1/nodes/{id}/traceroutes")
        async def node_traceroutes(request: Request, id: str) -> JSONResponse:
            node_id = self._coerce_node_id(id)
            try:
                limit = int(request.query_params.get("limit", 1000))
            except (TypeError, ValueError):
                return JSONResponse({"error": "limit must be an integer"}, status_code=400)
            traceroutes = await self.data.pg_storage.query_node_traceroutes(
                node_id, limit=max(1, min(limit, 10000))
            )
            return JSONResponse(jsonable_encoder({ "traceroutes": traceroutes }))

        @app.get("/v1/chat")
        async def chat(request: Request) -> JSONResponse:
            # Omitted = every channel.
            channel = request.query_params.get("channel") or None  # e.g. "8", "31"
            # "1h","24h","7d","all" — unknown values mean 24h.
            range_seconds = self._chat_range_seconds(request.query_params.get("range"))

            # Limit is per channel; high default is deliberate (range=all means all).
            try:
                limit = max(1, min(int(request.query_params.get("limit", 10000)), 50000))
            except (TypeError, ValueError):
                # Same contract as /v1/traceroutes: reject, don't silently default.
                return JSONResponse({"error": "limit must be an integer"}, status_code=400)

            chat_data = await self.data.pg_storage.query_chat_filtered(
                channel_id=channel,
                range_seconds=range_seconds,
                limit=limit,
            )
            return JSONResponse(jsonable_encoder(chat_data))

        @app.get("/v1/channels")
        async def channels_endpoint(request: Request) -> JSONResponse:
            """Channel buckets with display facts (name, counts), no messages.
            `range` scopes recentMessages exactly like /v1/chat."""
            range_seconds = self._chat_range_seconds(request.query_params.get("range"))
            channels_data = await self.data.pg_storage.query_channels(
                range_seconds=range_seconds
            )
            return JSONResponse(jsonable_encoder({"channels": channels_data}))

        @app.get("/v1/telemetry")
        async def telemetry(request: Request) -> JSONResponse:
            telemetry_data = await self.data.pg_storage.query_all_telemetry()
            return JSONResponse(jsonable_encoder(telemetry_data))

        @app.get("/v1/traceroutes")
        async def traceroutes(request: Request) -> JSONResponse:
            from_param = request.query_params.get("from")
            to_param = request.query_params.get("to")
            range_seconds = self._parse_range(request.query_params.get("range"))
            try:
                limit = int(request.query_params.get("limit", 1000))
            except (TypeError, ValueError):
                return JSONResponse({"error": "limit must be an integer"}, status_code=400)
            # ?slim=1 keeps only the row fields the SPA reads; default stays
            # byte-identical for third-party consumers.
            slim = request.query_params.get("slim", "").lower() in ("1", "true", "yes")
            # Pagination opt-in via ?envelope=1 ({traceroutes, next_cursor}); NOT
            # implied by slim — already-open tabs request slim=1 and expect a bare array.
            envelope = request.query_params.get("envelope", "").lower() in ("1", "true", "yes")
            before = request.query_params.get("before")
            traceroutes_data = await self.data.pg_storage.query_all_traceroutes(
                limit=max(1, min(limit, 10000)),
                from_node_id=self._coerce_node_id(from_param) if from_param else None,
                to_node_id=self._coerce_node_id(to_param) if to_param else None,
                range_seconds=range_seconds,
                slim=slim,
                before=before if envelope else None,
                with_cursor=envelope,
            )
            return JSONResponse(jsonable_encoder(traceroutes_data))

        @app.get("/v1/messages")
        async def messages(request: Request) -> JSONResponse:
            search = request.query_params.get("q")
            range_seconds = self._parse_range(request.query_params.get("range"))
            try:
                limit = int(request.query_params.get("limit", 5000))
            except (TypeError, ValueError):
                return JSONResponse({"error": "limit must be an integer"}, status_code=400)
            limit = max(1, min(limit, 50000))
            results = await self.data.pg_storage.query_mqtt_messages(
                limit=limit, search=search, range_seconds=range_seconds,
            )
            return JSONResponse(jsonable_encoder(results["messages"]))

        @app.get("/v1/mqtt_messages")
        async def mqtt_messages(request: Request) -> JSONResponse:
            range_seconds = self._parse_range(request.query_params.get("range"))
            try:
                limit = int(request.query_params.get("limit", 5000))
            except (TypeError, ValueError):
                return JSONResponse({"error": "limit must be an integer"}, status_code=400)
            limit = max(1, min(limit, 50000))
            results = await self.data.pg_storage.query_mqtt_messages(
                limit=limit, range_seconds=range_seconds,
            )
            return JSONResponse(jsonable_encoder(results["messages"]))

        @app.get("/v1/packets")
        async def packets(request: Request) -> JSONResponse:
            """Keyset-paginated packet archive. Unlike /v1/mqtt_messages (which
            returns only the newest window), this reaches the full history via
            absolute start/end (unix-epoch seconds) and a `before` cursor.
            Response: {"messages": [...], "next_cursor": str | null}."""
            search = request.query_params.get("q")
            range_seconds = self._parse_range(request.query_params.get("range"))
            try:
                limit = int(request.query_params.get("limit", 1000))
            except (TypeError, ValueError):
                return JSONResponse({"error": "limit must be an integer"}, status_code=400)
            limit = max(1, min(limit, 50000))
            result = await self.data.pg_storage.query_mqtt_messages(
                limit=limit,
                search=search,
                topic=request.query_params.get("topic"),
                range_seconds=range_seconds,
                start=self._parse_epoch(request.query_params.get("start")),
                end=self._parse_epoch(request.query_params.get("end")),
                before=request.query_params.get("before"),
            )
            return JSONResponse(jsonable_encoder(result))

        @app.get("/v1/packets/{packet_id}")
        async def packet_by_id(request: Request, packet_id: str) -> JSONResponse:
            """Single packet by `mqtt_messages` row id — backs per-packet deeplinks.
            ?copies=1 rebuilds every gateway's original uplink message from its
            reception row (dedup is lossless — see POSTGRES.md #526)."""
            try:
                row_id = int(packet_id)
            except (TypeError, ValueError):
                return JSONResponse({"error": "packet id must be an integer"}, status_code=400)
            include_copies = request.query_params.get("copies", "").lower() in ("1", "true", "yes")
            # ?by=packet&from=<node>: address by (sender, mesh packet id) —
            # what chat rows know — instead of the archive row id.
            if request.query_params.get("by") == "packet":
                from_id = utils.normalize_node_id(request.query_params.get("from") or "")
                if not from_id:
                    return JSONResponse(
                        {"error": "by=packet requires a valid from=<node id>"},
                        status_code=400,
                    )
                packet = await self.data.pg_storage.query_mqtt_message_by_packet(
                    from_id, row_id, include_copies=include_copies
                )
            else:
                packet = await self.data.pg_storage.query_mqtt_message_by_id(row_id, include_copies=include_copies)
            if packet is None:
                return JSONResponse({"error": "packet not found"}, status_code=404)
            return JSONResponse(jsonable_encoder({"packet": packet}))

        @app.get("/v1/stats")
        async def stats(request: Request) -> JSONResponse:
            stats = await self.data.pg_storage.query_stats()
            return JSONResponse(jsonable_encoder({"stats": stats}))

        @app.get("/v1/events")
        async def events(request: Request) -> StreamingResponse:
            """Server-Sent Events stream of live node + chat updates.

            One multiplexed connection per client; each frame carries an
            ``event:`` type (``node`` | ``chat``). The SPA's useLiveEvents hook
            patches the node cache in place and refetches chat. ``: ...``
            comment frames are heartbeats that keep an idle connection alive
            past uvicorn/proxy keep-alive timeouts. The endpoint inherits the
            same proxy route as the rest of /v1; Caddy serves it through a
            dedicated unbuffered handler (flush_interval -1)."""
            queue = self.data.broadcaster.subscribe()
            # Jittered per-connection reconnect delay. Without a `retry:`
            # directive browsers use a fixed ~3s with no jitter, so after an
            # API restart every open tab reconnects in the same instant.
            retry_ms = random.randint(3000, 8000)

            async def event_stream():
                # The initial comment flushes response headers immediately so
                # the browser fires EventSource.onopen, which drives the
                # client's reconnect resync.
                yield ": connected\n\n"
                yield f"retry: {retry_ms}\n\n"
                # Frame ids are epoch ms at send time, forced strictly
                # monotonic per connection so Last-Event-ID is unambiguous
                # for a future delta-resync endpoint (no server-side replay
                # of Last-Event-ID yet — documented follow-up).
                last_event_id = 0
                try:
                    while True:
                        if await request.is_disconnected():
                            break
                        try:
                            event_type, payload = await asyncio.wait_for(
                                queue.get(), timeout=20.0
                            )
                        except asyncio.TimeoutError:
                            yield ": heartbeat\n\n"
                            continue
                        data = json.dumps(payload, default=str)
                        last_event_id = max(last_event_id + 1, int(time.time() * 1000))
                        yield f"id: {last_event_id}\nevent: {event_type}\ndata: {data}\n\n"
                finally:
                    # Always deregister — covers disconnect, GeneratorExit, and
                    # task cancellation so a dropped client can't leak a queue.
                    self.data.broadcaster.unsubscribe(queue)

            return StreamingResponse(
                event_stream(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        @app.get("/v1/static-map")
        async def static_map(request: Request) -> Response:
            """Generate a static map PNG image for given coordinates."""
            # Presence check, not (0,0) reject — Null Island is a valid coordinate.
            lat_param = request.query_params.get("lat")
            lon_param = request.query_params.get("lon")
            if lat_param is None or lon_param is None:
                return JSONResponse({"error": "lat and lon are required"}, status_code=400)
            try:
                lat = float(lat_param)
                lon = float(lon_param)
                zoom = int(request.query_params.get("zoom", 12))
                width = int(request.query_params.get("width", 300))
                height = int(request.query_params.get("height", 200))
            except (ValueError, TypeError):
                return JSONResponse({"error": "Invalid parameters"}, status_code=400)

            zoom = max(1, min(zoom, 18))
            width = max(100, min(width, 800))
            height = max(100, min(height, 600))

            try:
                # Dedicated 2-thread pool: a render can block on tile fetches
                # for tens of seconds, and the default to_thread executor is
                # only 7 threads on this box — don't let renders pin it.
                png_bytes = await asyncio.get_running_loop().run_in_executor(
                    STATIC_MAP_EXECUTOR,
                    functools.partial(
                        generate_static_map, lat, lon, self.config,
                        zoom=zoom, width=width, height=height,
                    ),
                )
                return Response(
                    content=png_bytes,
                    media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"},
                )
            except MapUnavailableError:
                # Negative-cached failure — fail fast instead of re-fetching
                # the whole tile grid. Already logged when it first failed.
                return JSONResponse(
                    {"error": "Map generation failed"},
                    status_code=503,
                    headers={"Retry-After": "120"},
                )
            except Exception:
                logger.exception("Failed to generate static map")
                return JSONResponse({"error": "Map generation failed"}, status_code=500)

        @app.get("/v1/server/config")
        async def server_config(request: Request) -> JSONResponse:
            return JSONResponse(jsonable_encoder({'config': Config.cleanse(self.config)}))

        # Group = "all" or a modem-preset pyramid (e.g. "LongFast"); doubles as
        # a directory and URL segment, so validate it strictly.
        COVERAGE_GROUP_RE = re.compile(r"^[A-Za-z0-9-]{1,32}$")

        @app.get("/v1/coverage/metadata")
        async def coverage_metadata(request: Request) -> JSONResponse:
            """Coverage tile pyramid metadata (bounds, zoom range, version, groups).
            `?group=` selects a modem-preset pyramid (default "all"). 404 until first bake."""
            cov_cfg = self.config.get("coverage", {}) or {}
            if not cov_cfg.get("enabled", False):
                return JSONResponse({"error": "coverage disabled"}, status_code=404)
            group = request.query_params.get("group") or "all"
            if not COVERAGE_GROUP_RE.fullmatch(group):
                return JSONResponse({"error": "bad group"}, status_code=400)
            meta_path = Path(cov_cfg.get("tile_dir", "output/coverage")) / group / "metadata.json"
            if not meta_path.is_file():
                return JSONResponse({"error": "coverage not baked yet"}, status_code=404)
            try:
                data = await asyncio.to_thread(meta_path.read_text)
                return JSONResponse(json.loads(data), headers={"Cache-Control": "no-cache"})
            except Exception:
                logger.exception("Failed to read coverage metadata")
                return JSONResponse({"error": "metadata unreadable"}, status_code=500)

        # Shared keep-alive session for lookup proxying (created lazily on the
        # running loop; a fresh session + TCP connect per hover is wasteful).
        lookup_session: dict[str, aiohttp.ClientSession] = {}

        def get_lookup_session() -> aiohttp.ClientSession:
            s = lookup_session.get("s")
            if s is None or s.closed:
                s = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5))
                lookup_session["s"] = s
            return s

        @app.on_event("shutdown")
        async def close_lookup_session() -> None:
            s = lookup_session.get("s")
            if s is not None and not s.closed:
                await s.close()

        @app.get("/v1/coverage/lookup")
        async def coverage_lookup(request: Request) -> JSONResponse:
            """Nodes covering a point, sorted by margin. Proxies the coverage-worker."""
            cov_cfg = self.config.get("coverage", {}) or {}
            if not cov_cfg.get("enabled", False):
                return JSONResponse({"error": "coverage disabled"}, status_code=404)
            try:
                lng = float(request.query_params["lng"])
                lat = float(request.query_params["lat"])
            except (KeyError, ValueError):
                return JSONResponse({"error": "bad lng/lat"}, status_code=400)
            group = request.query_params.get("group") or "all"
            if not COVERAGE_GROUP_RE.fullmatch(group):
                return JSONResponse({"error": "bad group"}, status_code=400)
            url = cov_cfg.get("lookup_url", "http://coverage-worker:9301")
            try:
                session = get_lookup_session()
                async with session.get(f"{url}/lookup", params={"lng": lng, "lat": lat, "group": group}) as r:
                    return JSONResponse(await r.json(), status_code=r.status, headers={"Cache-Control": "no-cache"})
            except Exception:
                return JSONResponse({"error": "lookup unavailable"}, status_code=503)

        # Version last broadcast, so notify spam can't re-trigger every client.
        last_notified_version: dict[str, str] = {}

        @app.post("/v1/coverage/notify")
        async def coverage_notify(request: Request) -> JSONResponse:
            """Coverage-worker → SSE `coverage` event so live maps refetch tiles.
            The request body is ignored: the broadcast payload is read from the
            baked metadata on disk, so an unauthenticated POST can only announce
            what is actually served — and only once per baked version."""
            cov_cfg = self.config.get("coverage", {}) or {}
            if not cov_cfg.get("enabled", False):
                return JSONResponse({"error": "coverage disabled"}, status_code=404)
            meta_path = Path(cov_cfg.get("tile_dir", "output/coverage")) / "all" / "metadata.json"
            try:
                payload = json.loads(await asyncio.to_thread(meta_path.read_text))
            except Exception:
                return JSONResponse({"error": "no baked metadata"}, status_code=404)
            version = str(payload.get("version"))
            if last_notified_version.get("v") == version:
                return JSONResponse({"status": "unchanged"})
            last_notified_version["v"] = version
            self.data.broadcaster.publish("coverage", jsonable_encoder(payload))
            logger.info("Coverage tiles ready: %s", version)
            return JSONResponse({"status": "ok"})

        # Land-cover tiles for the coverage/scan clutter model. Pre-baked by
        # scripts/landcover_tiles.py; missing tiles 404 and the frontend falls
        # back to a default class. See RF-MODEL.md.
        landcover_cfg = self.config.get("landcover", {}) or {}
        if landcover_cfg.get("enabled", False):
            tile_dir = Path(landcover_cfg.get("tile_dir", "output/landcover"))
            if tile_dir.is_dir():
                app.mount(
                    "/tiles/landcover",
                    TileFiles(directory=str(tile_dir)),
                    name="landcover_tiles",
                )
                logger.info("Mounted land-cover tiles at /tiles/landcover from %s", tile_dir.resolve())
            else:
                logger.info(
                    "Land-cover tiles enabled but %s does not exist — frontend will use default class. "
                    "Run scripts/landcover_tiles.py to populate.",
                    tile_dir,
                )

        # Canopy-height tiles for the P.833-9 vegetation loss loop. Pre-baked by
        # scripts/canopy_tiles.py; missing tiles 404 and the frontend falls back
        # to class-nominal heights. See RF-MODEL.md.
        canopy_cfg = self.config.get("canopy", {}) or {}
        if canopy_cfg.get("enabled", False):
            tile_dir = Path(canopy_cfg.get("tile_dir", "output/canopy"))
            if tile_dir.is_dir():
                app.mount(
                    "/tiles/canopy",
                    TileFiles(directory=str(tile_dir)),
                    name="canopy_tiles",
                )
                logger.info("Mounted canopy-height tiles at /tiles/canopy from %s", tile_dir.resolve())
            else:
                logger.info(
                    "Canopy-height tiles enabled but %s does not exist — frontend will use class-nominal heights. "
                    "Run scripts/canopy_tiles.py to populate.",
                    tile_dir,
                )

        # Building-height tiles for the P.452 endpoint formula and ITM DSM.
        # Pre-baked by scripts/building_tiles.py; missing tiles 404 and the
        # frontend falls back to class-nominal. See RF-MODEL.md.
        buildings_cfg = self.config.get("buildings", {}) or {}
        if buildings_cfg.get("enabled", False):
            tile_dir = Path(buildings_cfg.get("tile_dir", "output/buildings"))
            if tile_dir.is_dir():
                app.mount(
                    "/tiles/buildings",
                    TileFiles(directory=str(tile_dir)),
                    name="building_tiles",
                )
                logger.info("Mounted building-height tiles at /tiles/buildings from %s", tile_dir.resolve())
            else:
                logger.info(
                    "Building-height tiles enabled but %s does not exist — frontend will use class-nominal heights. "
                    "Run scripts/building_tiles.py to populate.",
                    tile_dir,
                )

        # Live network-coverage tile pyramid, baked by the coverage-worker.
        # Created + mounted unconditionally when enabled so a fresh deploy needs
        # no meshinfo restart after the worker's first bake.
        coverage_cfg = self.config.get("coverage", {}) or {}
        if coverage_cfg.get("enabled", False):
            tile_dir = Path(coverage_cfg.get("tile_dir", "output/coverage"))
            try:
                tile_dir.mkdir(parents=True, exist_ok=True)
                app.mount(
                    "/tiles/coverage",
                    # no-cache (not no-store): tiles are live — clients revalidate
                    # per use and unchanged tiles 304 via stable hardlink ETags.
                    TileFiles(directory=str(tile_dir), cache_control="no-cache"),
                    name="coverage_tiles",
                )
                logger.info("Mounted coverage tiles at /tiles/coverage from %s", tile_dir.resolve())
            except Exception:
                logger.exception("Failed to mount coverage tiles from %s", tile_dir)

        # Strip stray quote chars — compose YAML can wrap values producing `'"*"'`.
        # Empty env → no middleware (the previous `[""]` was a deny-all that looked configured).
        raw_origins = os.getenv("ALLOW_ORIGINS", "")
        allow_origins = [o.strip().strip('"').strip("'") for o in raw_origins.split(",")]
        allow_origins = [o for o in allow_origins if o]

        if allow_origins:
            logger.info("Allowed origins: %s (%d)", allow_origins, len(allow_origins))
            app.add_middleware(
                CORSMiddleware,
                allow_origins=allow_origins,
                allow_credentials=True,
                allow_methods=["*"],
                allow_headers=["*"],
            )
        else:
            logger.info("ALLOW_ORIGINS not set — CORS middleware disabled")

        conf = uvicorn.Config(app=app, host="0.0.0.0", port=9000, loop="asyncio", log_config=None)
        server = uvicorn.Server(conf)
        logger.info("Starting Uvicorn server bound at http://%s:%d", conf.host, conf.port)
        await server.serve()
        logger.info("Uvicorn server stopped")