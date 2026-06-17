from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from app.db import db

router = APIRouter()

UPLOAD_DIR = Path("data/uploads")
SEPARATED_DIR = Path("data/separated")

MEDIA_TYPES = {".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg"}


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


@router.post("/api/jobs/{job_id}/source")
async def upload_source(job_id: str, request: Request):
    """Worker uploads a re-downloaded source file so future chord retries can find it."""
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
    source_path = job_dir / f"source{ext}"
    source_path.write_bytes(await request.body())
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
    stem_path = stem_dir / stem_name

    content = await request.body()
    stem_path.write_bytes(content)

    return {"ok": True}
