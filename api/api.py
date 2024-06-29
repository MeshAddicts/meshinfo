import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

templates = Jinja2Templates(directory="./templates/api")
app = FastAPI()


@app.get("/", response_class=HTMLResponse)
async def root(request: Request):
    return templates.TemplateResponse(name="index.html.j2", context={})


async def start_uvicorn(loop):
    config = uvicorn.Config(app, host="0.0.0.0", port=9000, loop=loop)
    server = uvicorn.Server(config)
    print(f"Starting Uvicorn server bound at http://{config.host}:{config.port}")
    await server.serve()
    print("Uvicorn server stopped")
