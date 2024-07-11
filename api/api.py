import json
from fastapi.encoders import jsonable_encoder
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

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
            nodes = self.data.nodes
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
                            if nodes[id]["active"] == True:
                                nodes_to_keep.append(id)
                        nodes = { k: v for k, v in nodes.items() if k in nodes_to_keep }
                    elif status == "offline":
                        nodes_to_keep = []
                        for id in nodes:
                            if nodes[id]["active"] == False:
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

            if node_id in self.data.telemetry:
                return jsonable_encoder({ "telemetry": self.data.telemetry[node_id] })
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
            else:
                return JSONResponse(status_code=404, content={"error": "texts not found"})

        @app.get("/v1/nodes/{id}/traceroutes")
        async def node_traceroutes(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
                node_id = utils.convert_node_id_from_int_to_hex(node_id)
            except ValueError:
                node_id = id

            if node_id in self.data.traceroutes:
                return jsonable_encoder({ "traceroutes": self.data.traceroutes[node_id] })
            else:
                return JSONResponse(status_code=404, content={"error": "traceroutes not found"})


        @app.get("/v1/server/config")
        async def server_config(request: Request) -> JSONResponse:
            # TODO: Sanitize config (i.e. username, password, api_key, etc)
            return jsonable_encoder({ "config": self.config })



        conf = uvicorn.Config(app=app, host="0.0.0.0", port=9000, loop=loop)
        server = uvicorn.Server(conf)
        print(f"Starting Uvicorn server bound at http://{conf.host}:{conf.port}")
        await server.serve()
        print("Uvicorn server stopped")
