import datetime
import os
from fastapi.encoders import jsonable_encoder
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

from config import Config
import utils

templates = Jinja2Templates(directory="./templates/api")
app = FastAPI()

class API:
    def __init__(self, config, data):
        self.config = config
        self.data = data

    async def serve(self, loop):
        @app.get("/", response_class=HTMLResponse)
        async def root(request: Request):
            return templates.TemplateResponse(request=request, name="index.html.j2", context={})

        @app.get("/v1/nodes")
        async def nodes(request: Request) -> JSONResponse:
            # get nodes that have been updated within last X days
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
                            if nodes[id]["active"]:
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

            traceroutes = []
            for traceroute in self.data.traceroutes:
                if traceroute['from'] == node_id or traceroute['to'] == node_id:
                    traceroutes.append(traceroute)
            return jsonable_encoder({ "traceroutes": traceroutes })

        @app.get("/v1/chat")
        async def chat(request: Request) -> JSONResponse:
            # Calculate message count for each channel
            channels = self.data.chat['channels'].keys()
            print(channels)
            chat = {
                "channels": [ { "id": x, "totalMessages": len(self.data.chat['channels'][x]['messages']), "messages": [] } for x in channels ]
            }
            return jsonable_encoder(chat)

        @app.get("/v1/chat/{channel}/messages")
        async def chat_messages(request: Request) -> JSONResponse:
            channel = request.path_params.get("channel")
            if channel is None:
                return JSONResponse(status_code=404, content={"error": "channel not found"})

            # Sort by timestamp descending and paginate (100 per page)
            messages = sorted(self.data.chat['channels'][channel]['messages'], key=lambda x: x['timestamp'], reverse=True)
            messages = messages[:100]
            return jsonable_encoder(self.data.chat)

        @app.get("/v1/telemetry")
        async def telemetry(request: Request) -> JSONResponse:
            return jsonable_encoder(self.data.telemetry[:1000])

        @app.get("/v1/traceroutes")
        async def traceroutes(request: Request) -> JSONResponse:
            return jsonable_encoder(self.data.traceroutes[:1000])

        @app.get("/v1/messages")
        async def messages(request: Request) -> JSONResponse:
            return jsonable_encoder(self.data.messages[:1000])

        @app.get("/v1/mqtt_messages")
        async def mqtt_messages(request: Request) -> JSONResponse:
            return jsonable_encoder(self.data.mqtt_messages[:1000])

        @app.get("/v1/stats")
        async def stats(request: Request) -> JSONResponse:
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

        @app.get("/v1/server/config")
        async def server_config(request: Request) -> JSONResponse:
            return jsonable_encoder({'config': Config.cleanse(self.config)})


        allow_origins = os.getenv("ALLOW_ORIGINS", "").split(",")
        print(f"Allowed origins: {allow_origins} {len(allow_origins)}")

        if(len(allow_origins) > 0):
            app.add_middleware(
                CORSMiddleware,
                allow_origins=allow_origins,
                allow_credentials=True,
                allow_methods=["*"],
                allow_headers=["*"]
            )

        conf = uvicorn.Config(app=app, host="0.0.0.0", port=9000, loop=loop)
        server = uvicorn.Server(conf)
        print(f"Starting Uvicorn server bound at http://{conf.host}:{conf.port}")
        await server.serve()
        print("Uvicorn server stopped")
