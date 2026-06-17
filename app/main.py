import os
from contextlib import asynccontextmanager
from pathlib import Path

import certifi

os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.db import init_db
from app.routes.audio import router as audio_router
from app.routes.jobs import router as jobs_router
from app.routes.settings import router as settings_router
from app.routes.upload import router as upload_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    Path("data/uploads").mkdir(parents=True, exist_ok=True)
    Path("data/separated").mkdir(parents=True, exist_ok=True)
    init_db()
    print("[app] ready", flush=True)
    yield


app = FastAPI(lifespan=lifespan)

app.include_router(upload_router)
app.include_router(jobs_router)
app.include_router(audio_router)
app.include_router(settings_router)

app.mount("/", StaticFiles(directory="static", html=True), name="static")
