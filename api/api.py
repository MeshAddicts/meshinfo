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

        @app.get("/v1/config")
        async def config(request: Request) -> JSONResponse:
            # TODO: Sanitize config (i.e. username, password, api_key, etc)
            return jsonable_encoder({ "config": self.config })

        @app.get("/v1/nodes")
        async def nodes(request: Request) -> JSONResponse:
            return jsonable_encoder({"nodes": self.data.nodes })

        @app.get("/v1/nodes/{id}")
        async def node(request: Request, id: str) -> JSONResponse:
            try:
                node_id = int(id)
            except ValueError:
                node_id = id

            if isinstance(node_id, str) and id in self.data.nodes:
                return jsonable_encoder({ "node": self.data.nodes[node_id] })
            elif isinstance(node_id, int) and utils.convert_node_id_from_int_to_hex(node_id) in self.data.nodes:
                return jsonable_encoder({ "node": self.data.nodes[utils.convert_node_id_from_int_to_hex(node_id)] })
            else:
                return JSONResponse(status_code=404, content={"error": "Node not found"})



        config = uvicorn.Config(app, host="0.0.0.0", port=9000, loop=loop)
        server = uvicorn.Server(config)
        print(f"Starting Uvicorn server bound at http://{config.host}:{config.port}")
        await server.serve()
        print("Uvicorn server stopped")
