import json
from fastapi.encoders import jsonable_encoder
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

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

        @app.get("/nodes")
        async def nodes(request: Request) -> JSONResponse:
            return jsonable_encoder(self.data.nodes)

        config = uvicorn.Config(app, host="0.0.0.0", port=9000, loop=loop)
        server = uvicorn.Server(config)
        print(f"Starting Uvicorn server bound at http://{config.host}:{config.port}")
        await server.serve()
        print("Uvicorn server stopped")
