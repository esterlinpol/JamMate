import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.db import db

router = APIRouter()

SEPARATED_DIR = Path("data/separated")


class JobPatch(BaseModel):
    status: Optional[str] = None
    progress: Optional[float] = None
    progress_phase: Optional[str] = None
    stem_base: Optional[str] = None
    chord_data: Optional[str] = None
    chord_source: Optional[str] = None
    chord_source_url: Optional[str] = None
    capo: Optional[int] = None
    error_msg: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None


@router.get("/api/jobs")
async def list_jobs():
    with db() as conn:
        rows = conn.execute(
            """SELECT id, title, artist, filename, source_type, status, model, shifts,
                      chord_source, progress, progress_phase, error_msg, created_at
               FROM jobs ORDER BY created_at DESC"""
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/jobs/pending")
async def get_pending():
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
    if not row:
        return {"job": None}
    return {"job": dict(row)}


@router.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return JSONResponse({"error": "not found"}, status_code=404)
    return dict(row)


@router.patch("/api/jobs/{job_id}")
async def patch_job(job_id: str, patch: JobPatch):
    updates = {k: v for k, v in patch.model_dump().items() if v is not None}
    if not updates:
        return {"ok": True}
    updates["updated_at"] = time.time()
    cols = ", ".join(f"{k} = ?" for k in updates)
    vals = list(updates.values()) + [job_id]
    with db() as conn:
        conn.execute(f"UPDATE jobs SET {cols} WHERE id = ?", vals)
    return {"ok": True}


@router.get("/api/stems/{job_id}")
async def get_stems(job_id: str):
    with db() as conn:
        row = conn.execute(
            "SELECT status, filename, chord_data, chord_source, chord_source_url, capo FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
    if not row:
        return JSONResponse({"error": "not found"}, status_code=404)
    if row["status"] != "done":
        return JSONResponse({"error": "not ready", "status": row["status"]}, status_code=400)

    stem_dir = SEPARATED_DIR / job_id
    if not stem_dir.exists():
        return JSONResponse({"error": "stems directory not found"}, status_code=404)

    stems = sorted(f.name for f in stem_dir.iterdir() if f.suffix in (".ogg", ".wav", ".mp3"))
    return {
        "stems": stems,
        "filename": row["filename"],
        "chord_data": row["chord_data"],
        "chord_source": row["chord_source"],
        "chord_source_url": row["chord_source_url"],
        "capo": row["capo"] or 0,
    }


@router.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    import shutil
    from pathlib import Path

    UPLOAD_DIR = Path("data/uploads")

    with db() as conn:
        row = conn.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))

    for d in (UPLOAD_DIR / job_id, SEPARATED_DIR / job_id):
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)

    return {"ok": True}
