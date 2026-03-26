import datetime
import logging
import os
from fastapi.encoders import jsonable_encoder
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from fastapi.responses import Response
from config import Config
from api.static_map import generate_static_map
import utils

logger = logging.getLogger(__name__)

app = FastAPI()

class API:
    def __init__(self, config, data):
        self.config = config
        self.data = data
        self.read_from_postgres = config.get('storage', {}).get('read_from') == 'postgres'

    async def serve(self):
        @app.get("/")
        async def root():
            return {"status": "ok", "service": "meshinfo-api"}

        @app.get("/v1/nodes")
        async def nodes(request: Request) -> JSONResponse:
            if self.read_from_postgres:
                # Query directly from PostgreSQL
                days_to_limit = 7
                if "days" in request.query_params.keys():
                    days_param: str|None = request.query_params.get("days")
                    if days_param is not None:
                        days_to_limit = int(days_param)
                if days_to_limit < 1:
                    days_to_limit = 1

                # Parse node IDs filter
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

                # Parse filters
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

                # Query from Postgres
                nodes = await self.data.pg_storage.query_nodes_filtered(
                    days_limit=days_to_limit,
                    node_ids=node_ids,
                    longname_filter=longname_filter,
                    shortname_filter=shortname_filter,
                    status_filter=status_filter
                )

                return jsonable_encoder({ "nodes": nodes, "count": len(nodes) })
            else:
                # Use in-memory data (JSON mode)
                days_to_limit = 7
                if "days" in request.query_params.keys():
                    days_param: str|None = request.query_params.get("days")
                    if days_param is not None:
                        days_to_limit = int(days_param)
                if days_to_limit < 1:
                    days_to_limit = 1

                nodes = { k: v for k, v in self.data.nodes.items() if utils.days_since_datetime(v["last_seen"]) <= days_to_limit }

                # filter nodes by query parameters
                if "ids" in request.query_params.keys():
                    ids: str|None = request.query_params.get("ids")
                    if ids is not None:
                        ids = ids.strip()
                        if ids != "":
                            nodes_to_keep = []
                            for id in ids.split(","):
                                try:
                                    node_id = int(id)
                                    node_id = utils.convert_node_id_from_int_to_hex(node_id)
                                except ValueError:
                                    node_id = id
                                if id in self.data.nodes:
                                    nodes_to_keep.append(node_id)
                            nodes = { k: v for k, v in nodes.items() if k in nodes_to_keep }

                if "long_name" in request.query_params.keys():
                    longname: str|None = request.query_params.get("long_name")
                    if longname is not None:
                        longname = longname.strip()
                        if longname != "":
                            nodes_to_keep = []
                            for id in nodes:
                                if longname.lower() in nodes[id]["longname"].lower():
                                    nodes_to_keep.append(id)
                            nodes = { k: v for k, v in nodes.items() if k in nodes_to_keep }

                if "short_name" in request.query_params.keys():
                    shortname: str|None = request.query_params.get("short_name")
                    if shortname is not None:
                        shortname = shortname.strip()
                        if shortname != "":
                            nodes_to_keep = []
                            for id in nodes:
                                if shortname.lower() in nodes[id]["shortname"].lower():
                                    nodes_to_keep.append(id)
                            nodes = { k: v for k, v in nodes.items() if k in nodes_to_keep }

                if "status" in request.query_params.keys():
                    status: str|None = request.query_params.get("status")
                    if status is not None:
                        status = status.strip()
                        if status == "online":
                            nodes_to_keep = []
                            for id in nodes:
                                if nodes[id]["active"]:
                                    nodes_to_keep.append(id)
                            nodes = { k: v for k, v in nodes.items() if k in nodes_to_keep }
                        elif status == "offline":
                            nodes_to_keep = []
                            for id in nodes:
                                if not nodes[id]["active"]:
                                    nodes_to_keep.append(id)
                            nodes = { k: v for k, v in nodes.items() if k in nodes_to_keep }

                return jsonable_encoder({ "nodes": nodes, "count": len(nodes) })

        @app.get("/v1/nodes/{id}")
        async def node(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id

            if self.read_from_postgres:
                node_data = await self.data.pg_storage.query_node_by_id(node_id)
                if node_data:
                    return jsonable_encoder({ "node": node_data })
                else:
                    return JSONResponse(status_code=404, content={"error": "node not found"})
            else:
                if node_id in self.data.nodes:
                    return jsonable_encoder({ "node": self.data.nodes[node_id] })
                else:
                    return JSONResponse(status_code=404, content={"error": "node not found"})

        @app.get("/v1/nodes/{id}/telemetry")
        async def node_telemetry(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id

            if self.read_from_postgres:
                telemetry_data = await self.data.pg_storage.query_node_telemetry(node_id)
                if telemetry_data:
                    return jsonable_encoder({ "telemetry": telemetry_data })
                else:
                    return JSONResponse(status_code=404, content={"error": "telemetry not found"})
            else:
                if node_id in self.data.telemetry_by_node:
                    return jsonable_encoder({ "telemetry": self.data.telemetry_by_node[node_id] })
                else:
                    return JSONResponse(status_code=404, content={"error": "telemetry not found"})

        @app.get("/v1/nodes/{id}/texts")
        async def node_text(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id

            if self.read_from_postgres:
                texts = await self.data.pg_storage.query_node_texts(node_id)
                return jsonable_encoder({ "texts": texts })
            else:
                texts = []
                for channel in self.data.chat['channels'].keys():
                    for message in self.data.chat['channels'][channel]['messages']:
                        if message['from'] == node_id or message['to'] == node_id:
                            texts.append(message)
                return jsonable_encoder({ "texts": texts })

        @app.get("/v1/nodes/{id}/traceroutes")
        async def node_traceroutes(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id

            if self.read_from_postgres:
                traceroutes = await self.data.pg_storage.query_node_traceroutes(node_id)
                return jsonable_encoder({ "traceroutes": traceroutes })
            else:
                traceroutes = []
                for traceroute in self.data.traceroutes:
                    if traceroute['from'] == node_id or traceroute['to'] == node_id:
                        traceroutes.append(traceroute)
                return jsonable_encoder({ "traceroutes": traceroutes })

        @app.get("/v1/chat")
        async def chat(request: Request) -> JSONResponse:
            if self.read_from_postgres:
                # Parse query params
                channel = request.query_params.get("channel") or "0"  # e.g. "8", "0"
                range_param = request.query_params.get("range", "24h")  # "1h","24h","7d","all"

                range_map = {
                    "1h": 3600,
                    "24h": 86400,
                    "7d": 604800,
                    "all": None,
                }
                range_seconds = range_map.get(range_param)
                # If range_param is unrecognized, default to 24h
                if range_param not in range_map:
                    range_seconds = 86400

                chat_data = await self.data.pg_storage.query_chat_filtered(
                    channel_id=channel,
                    range_seconds=range_seconds,
                )
                return jsonable_encoder(chat_data)
            else:
                return jsonable_encoder(self.data.chat)

        @app.get("/v1/telemetry")
        async def telemetry(request: Request) -> JSONResponse:
            if self.read_from_postgres:
                telemetry_data = await self.data.pg_storage.query_all_telemetry()
                return jsonable_encoder(telemetry_data)
            else:
                return jsonable_encoder(self.data.telemetry[:1000])

        @app.get("/v1/traceroutes")
        async def traceroutes(request: Request) -> JSONResponse:
            if self.read_from_postgres:
                traceroutes_data = await self.data.pg_storage.query_all_traceroutes()
                return jsonable_encoder(traceroutes_data)
            else:
                return jsonable_encoder(self.data.traceroutes[:1000])

        @app.get("/v1/messages")
        async def messages(request: Request) -> JSONResponse:
            # Messages and MQTT messages are not stored in Postgres, always use memory
            return jsonable_encoder(self.data.messages[:1000])

        @app.get("/v1/mqtt_messages")
        async def mqtt_messages(request: Request) -> JSONResponse:
            # Messages and MQTT messages are not stored in Postgres, always use memory
            return jsonable_encoder(self.data.mqtt_messages[:1000])

        @app.get("/v1/stats")
        async def stats(request: Request) -> JSONResponse:
            if self.read_from_postgres:
                stats = await self.data.pg_storage.query_stats()
                # Add in-memory only data
                stats['total_messages'] = len(self.data.messages)
                stats['total_mqtt_messages'] = len(self.data.mqtt_messages)
                return jsonable_encoder({"stats": stats})
            else:
                stats = {
                    'active_nodes': 0,
                    'total_chat': len(self.data.chat['channels']['0']['messages']),
                    'total_nodes': len(self.data.nodes),
                    'total_messages': len(self.data.messages),
                    'total_mqtt_messages': len(self.data.mqtt_messages),
                    'total_telemetry': len(self.data.telemetry),
                    'total_traceroutes': len(self.data.traceroutes),
                }
                for _, node in self.data.nodes.items():
                    if 'active' in node and node['active']:
                        stats['active_nodes'] += 1

                return jsonable_encoder({"stats": stats})

        @app.get("/v1/static-map")
        async def static_map(request: Request) -> Response:
            """Generate a static map PNG image for given coordinates."""
            try:
                lat = float(request.query_params.get("lat", 0))
                lon = float(request.query_params.get("lon", 0))
            except (ValueError, TypeError):
                return JSONResponse({"error": "Invalid lat/lon"}, status_code=400)

            if lat == 0 and lon == 0:
                return JSONResponse({"error": "lat and lon are required"}, status_code=400)

            zoom = int(request.query_params.get("zoom", 12))
            zoom = max(1, min(zoom, 18))

            try:
                png_bytes = generate_static_map(lat, lon, self.config, zoom=zoom)
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