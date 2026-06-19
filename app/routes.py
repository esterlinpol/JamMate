import json
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from app.db import db

router = APIRouter()

UPLOAD_DIR = Path("data/uploads")
SEPARATED_DIR = Path("data/separated")
MEDIA_TYPES = {".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg"}
ALLOWED_MODELS = {"htdemucs", "htdemucs_ft", "htdemucs_6s"}

_SUFFIX_RE = re.compile(r'\s*[\(\[][^\)\]]*[\)\]]')
_FILLER = {"official video", "official audio", "official music video", "lyrics",
           "lyric video", "audio", "hd", "hq", "letra", "subtitulado"}


# ── Helpers ───────────────────────────────────────────────────────────────────

def safe_stem(filename: str) -> str:
    return re.sub(r"[^\w\-]", "_", Path(filename).stem)


def _parse_yt_title(raw_title: str, channel: str) -> tuple[str, str]:
    clean = _SUFFIX_RE.sub("", raw_title).strip()
    if " - " in clean:
        left, right = clean.split(" - ", 1)
        left, right = left.strip(), right.strip()
        if right.lower() in _FILLER:
            left, right = right, left
        return left, right
    return channel, clean or raw_title


def _range_response(path: Path, media_type: str, range_header: str | None) -> Response:
    file_size = path.stat().st_size
    if not range_header:
        return FileResponse(str(path), media_type=media_type, headers={"Accept-Ranges": "bytes"})

    range_val = range_header.strip().removeprefix("bytes=")
    start_str, _, end_str = range_val.partition("-")
    start = int(start_str) if start_str else 0
    end = int(end_str) if end_str else file_size - 1
    end = min(end, file_size - 1)
    length = end - start + 1

    with open(path, "rb") as f:
        f.seek(start)
        data = f.read(length)

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Content-Type": media_type,
    }
    return Response(data, status_code=206, headers=headers)


# ── Pydantic models ───────────────────────────────────────────────────────────

class JobPatch(BaseModel):
    status: Optional[str] = None
    progress: Optional[float] = None
    progress_phase: Optional[str] = None
    stem_base: Optional[str] = None
    chord_data: Optional[str] = None
    chord_source: Optional[str] = None
    chord_source_url: Optional[str] = None
    capo: Optional[int] = None
    duration_sec: Optional[float] = None
    error_msg: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None


class SettingsPatch(BaseModel):
    worker_device: Optional[str] = None
    preferred_chord_source: Optional[str] = None


# ── Jobs ──────────────────────────────────────────────────────────────────────

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


@router.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    with db() as conn:
        row = conn.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))

    for d in (UPLOAD_DIR / job_id, SEPARATED_DIR / job_id):
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)

    return {"ok": True}


# ── Stems ─────────────────────────────────────────────────────────────────────

@router.get("/api/stems/{job_id}")
async def get_stems(job_id: str):
    with db() as conn:
        row = conn.execute(
            "SELECT status, filename, chord_data, chord_source, chord_source_url, capo, duration_sec FROM jobs WHERE id = ?",
            (job_id,)
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
        "duration_sec": row["duration_sec"],
    }


# ── Audio serving ─────────────────────────────────────────────────────────────

@router.post("/api/jobs/{job_id}/source")
async def upload_source(job_id: str, request: Request):
    with db() as conn:
        row = conn.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return JSONResponse({"error": "not found"}, status_code=404)

    cd = request.headers.get("content-disposition", "")
    ext = ".mp3"
    if "filename=" in cd:
        ext = Path(cd.split("filename=")[-1].strip().strip('"')).suffix or ".mp3"

    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / f"source{ext}").write_bytes(await request.body())
    return {"ok": True}


@router.get("/api/audio/{job_id}/source")
async def get_source(job_id: str):
    with db() as conn:
        row = conn.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return JSONResponse({"error": "not found"}, status_code=404)

    job_dir = UPLOAD_DIR / job_id
    if not job_dir.exists():
        return JSONResponse({"error": "source not found"}, status_code=404)

    for f in job_dir.iterdir():
        if f.stem == "source":
            media_type = MEDIA_TYPES.get(f.suffix, "application/octet-stream")
            return FileResponse(str(f), media_type=media_type, filename=f.name)

    return JSONResponse({"error": "source file not found"}, status_code=404)


@router.get("/api/audio/{job_id}/{stem_file}")
async def get_stem(job_id: str, stem_file: str, request: Request):
    with db() as conn:
        row = conn.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return JSONResponse({"error": "not found"}, status_code=404)

    audio_path = SEPARATED_DIR / job_id / stem_file
    if not audio_path.exists():
        return JSONResponse({"error": "file not found"}, status_code=404)

    media_type = MEDIA_TYPES.get(audio_path.suffix.lower(), "audio/ogg")
    return _range_response(audio_path, media_type, request.headers.get("range"))


@router.post("/api/jobs/{job_id}/stems/{stem_name}")
async def upload_stem(job_id: str, stem_name: str, request: Request):
    with db() as conn:
        row = conn.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return JSONResponse({"error": "not found"}, status_code=404)

    stem_dir = SEPARATED_DIR / job_id
    stem_dir.mkdir(parents=True, exist_ok=True)
    (stem_dir / stem_name).write_bytes(await request.body())
    return {"ok": True}


# ── Upload ────────────────────────────────────────────────────────────────────

@router.get("/api/youtube/metadata")
async def youtube_metadata(url: str):
    oembed = "https://www.youtube.com/oembed?url=" + urllib.parse.quote(url, safe="") + "&format=json"
    try:
        req = urllib.request.Request(oembed, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return JSONResponse({"error": f"YouTube returned {e.code}"}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    raw_title = data.get("title", "")
    channel = data.get("author_name", "")
    artist, title = _parse_yt_title(raw_title, channel)
    return {"title": title, "artist": artist, "raw_title": raw_title}


@router.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    model: str = Form("htdemucs_6s"),
    shifts: int = Form(0),
    title: str = Form(""),
    artist: str = Form(""),
):
    if model not in ALLOWED_MODELS:
        return JSONResponse({"error": f"Unknown model '{model}'"}, status_code=400)
    if not (0 <= shifts <= 10):
        return JSONResponse({"error": "shifts must be 0–10"}, status_code=400)

    job_id = str(uuid.uuid4())
    ext = Path(file.filename or "audio.mp3").suffix or ".mp3"
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / f"source{ext}").write_bytes(await file.read())

    display_title = title.strip() or safe_stem(file.filename or "Unknown")
    now = time.time()

    with db() as conn:
        conn.execute(
            """INSERT INTO jobs
               (id, title, artist, filename, source_type, status, model, shifts, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'upload', 'pending', ?, ?, ?, ?)""",
            (job_id, display_title, artist.strip(), file.filename or "", model, shifts, now, now),
        )

    return {"job_id": job_id}


@router.post("/api/youtube")
async def add_youtube(
    url: str = Form(...),
    title: str = Form(""),
    artist: str = Form(""),
):
    job_id = str(uuid.uuid4())
    now = time.time()

    with db() as conn:
        conn.execute(
            """INSERT INTO jobs
               (id, title, artist, filename, source_type, source_url, status, model, shifts, created_at, updated_at)
               VALUES (?, ?, ?, '', 'youtube', ?, 'pending', 'htdemucs_6s', 0, ?, ?)""",
            (job_id, title.strip() or "YouTube song", artist.strip(), url.strip(), now, now),
        )

    return {"job_id": job_id}


# ── Settings ──────────────────────────────────────────────────────────────────

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
