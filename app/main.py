import os
from contextlib import asynccontextmanager
from pathlib import Path

import certifi

os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from jinjax import Catalog

from app.db import init_db
from app.routes import router

catalog = Catalog(file_ext=".html")
catalog.add_folder("components")


@asynccontextmanager
async def lifespan(_: FastAPI):
    Path("data/uploads").mkdir(parents=True, exist_ok=True)
    Path("data/separated").mkdir(parents=True, exist_ok=True)
    init_db()
    print("[app] ready", flush=True)
    yield


app = FastAPI(lifespan=lifespan)

app.include_router(router)

@app.get("/")
async def index():
    return HTMLResponse(catalog.render("Layout"))

app.mount("/static", StaticFiles(directory="static"), name="static")
