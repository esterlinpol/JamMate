import time
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from app.db import db

router = APIRouter()


class SettingsPatch(BaseModel):
    worker_device: Optional[str] = None
    preferred_chord_source: Optional[str] = None


@router.get("/api/settings")
async def get_settings():
    with db() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}


@router.post("/api/settings")
async def update_settings(patch: SettingsPatch):
    updates = {k: v for k, v in patch.model_dump().items() if v is not None}
    with db() as conn:
        for key, value in updates.items():
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value)
            )
    return {"ok": True}


@router.post("/api/settings/worker-heartbeat")
async def worker_heartbeat():
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('worker_last_seen', ?)",
            (str(time.time()),),
        )
    return {"ok": True}
