import asyncio
import datetime
import logging
import os
from pathlib import Path
from fastapi.encoders import jsonable_encoder
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import FileResponse

from config import Config
from api.static_map import generate_static_map
import utils

logger = logging.getLogger(__name__)

app = FastAPI()


class TileFiles(StaticFiles):
    """StaticFiles with a 1-day cache header. Re-bakes for a new NLCD vintage
    propagate to clients within ~24 h; Starlette's built-in ETag handling makes
    the post-cache revalidation a free 304 when the file hasn't changed."""
    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if isinstance(response, FileResponse):
            response.headers["Cache-Control"] = "public, max-age=86400"
        return response

class API:
    def __init__(self, config, data):
        self.config = config
        self.data = data

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

    async def serve(self):
        @app.get("/")
        async def root():
            return {"status": "ok", "service": "meshinfo-api"}

        @app.get("/v1/nodes")
        async def nodes(request: Request) -> JSONResponse:
            days_to_limit = 7
            if "days" in request.query_params.keys():
                days_param: str|None = request.query_params.get("days")
                if days_param is not None:
                    days_to_limit = int(days_param)
            if days_to_limit < 1:
                days_to_limit = 1

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

            nodes = await self.data.pg_storage.query_nodes_filtered(
                days_limit=days_to_limit,
                node_ids=node_ids,
                longname_filter=longname_filter,
                shortname_filter=shortname_filter,
                status_filter=status_filter
            )

            return jsonable_encoder({ "nodes": nodes, "count": len(nodes) })

        @app.get("/v1/nodes/{id}")
        async def node(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id

            node_data = await self.data.pg_storage.query_node_by_id(node_id)
            if node_data:
                return jsonable_encoder({ "node": node_data })
            return JSONResponse(status_code=404, content={"error": "node not found"})

        @app.get("/v1/nodes/{id}/telemetry")
        async def node_telemetry(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id

            telemetry_data = await self.data.pg_storage.query_node_telemetry(node_id)
            if telemetry_data:
                return jsonable_encoder({ "telemetry": telemetry_data })
            return JSONResponse(status_code=404, content={"error": "telemetry not found"})

        @app.get("/v1/nodes/{id}/texts")
        async def node_text(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id

            texts = await self.data.pg_storage.query_node_texts(node_id)
            return jsonable_encoder({ "texts": texts })

        @app.get("/v1/nodes/{id}/packets")
        async def node_packets(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id.lstrip("!")

            try:
                limit = int(request.query_params.get("limit", 50))
            except (TypeError, ValueError):
                limit = 50
            limit = max(1, min(limit, 200))

            packets = await self.data.pg_storage.query_node_mqtt_messages(node_id, limit=limit)
            return jsonable_encoder({"packets": packets})

        @app.get("/v1/nodes/{id}/traceroutes")
        async def node_traceroutes(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id

            traceroutes = await self.data.pg_storage.query_node_traceroutes(node_id)
            return jsonable_encoder({ "traceroutes": traceroutes })

        @app.get("/v1/chat")
        async def chat(request: Request) -> JSONResponse:
            channel = request.query_params.get("channel") or "0"  # e.g. "8", "0"
            range_param = request.query_params.get("range", "24h")  # "1h","24h","7d","all"

            range_map = {
                "1h": 3600,
                "24h": 86400,
                "7d": 604800,
                "all": None,
            }
            range_seconds = range_map.get(range_param)
            if range_param not in range_map:
                range_seconds = 86400

            chat_data = await self.data.pg_storage.query_chat_filtered(
                channel_id=channel,
                range_seconds=range_seconds,
            )
            return jsonable_encoder(chat_data)

        @app.get("/v1/telemetry")
        async def telemetry(request: Request) -> JSONResponse:
            telemetry_data = await self.data.pg_storage.query_all_telemetry()
            return jsonable_encoder(telemetry_data)

        @app.get("/v1/traceroutes")
        async def traceroutes(request: Request) -> JSONResponse:
            traceroutes_data = await self.data.pg_storage.query_all_traceroutes()
            return jsonable_encoder(traceroutes_data)

        @app.get("/v1/messages")
        async def messages(request: Request) -> JSONResponse:
            search = request.query_params.get("q")
            range_seconds = self._parse_range(request.query_params.get("range"))
            limit = int(request.query_params.get("limit", 5000))
            limit = max(1, min(limit, 50000))
            results = await self.data.pg_storage.query_mqtt_messages(
                limit=limit, search=search, range_seconds=range_seconds,
            )
            return jsonable_encoder(results)

        @app.get("/v1/mqtt_messages")
        async def mqtt_messages(request: Request) -> JSONResponse:
            range_seconds = self._parse_range(request.query_params.get("range"))
            limit = int(request.query_params.get("limit", 5000))
            limit = max(1, min(limit, 50000))
            results = await self.data.pg_storage.query_mqtt_messages(
                limit=limit, range_seconds=range_seconds,
            )
            return jsonable_encoder(results)

        @app.get("/v1/stats")
        async def stats(request: Request) -> JSONResponse:
            stats = await self.data.pg_storage.query_stats()
            return jsonable_encoder({"stats": stats})

        @app.get("/v1/static-map")
        async def static_map(request: Request) -> Response:
            """Generate a static map PNG image for given coordinates."""
            try:
                lat = float(request.query_params.get("lat", 0))
                lon = float(request.query_params.get("lon", 0))
                zoom = int(request.query_params.get("zoom", 12))
                width = int(request.query_params.get("width", 300))
                height = int(request.query_params.get("height", 200))
            except (ValueError, TypeError):
                return JSONResponse({"error": "Invalid parameters"}, status_code=400)

            if lat == 0 and lon == 0:
                return JSONResponse({"error": "lat and lon are required"}, status_code=400)

            zoom = max(1, min(zoom, 18))
            width = max(100, min(width, 800))
            height = max(100, min(height, 600))

            try:
                png_bytes = await asyncio.to_thread(generate_static_map, lat, lon, self.config, zoom=zoom, width=width, height=height)
                return Response(
                    content=png_bytes,
                    media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"},
                )
            except Exception:
                logger.exception("Failed to generate static map")
                return JSONResponse({"error": "Map generation failed"}, status_code=500)

        @app.get("/v1/server/config")
        async def server_config(request: Request) -> JSONResponse:
            return jsonable_encoder({'config': Config.cleanse(self.config)})

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

        allow_origins = os.getenv("ALLOW_ORIGINS", "").split(",")
        logger.info("Allowed origins: %s (%d)", allow_origins, len(allow_origins))

        if(len(allow_origins) > 0):
            app.add_middleware(
                CORSMiddleware,
                allow_origins=allow_origins,
                allow_credentials=True,
                allow_methods=["*"],
                allow_headers=["*"]
            )

        conf = uvicorn.Config(app=app, host="0.0.0.0", port=9000, loop="asyncio", log_config=None)
        server = uvicorn.Server(conf)
        logger.info("Starting Uvicorn server bound at http://%s:%d", conf.host, conf.port)
        await server.serve()
        logger.info("Uvicorn server stopped")