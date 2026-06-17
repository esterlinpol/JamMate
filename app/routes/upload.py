import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

from app.db import db

router = APIRouter()

UPLOAD_DIR = Path("data/uploads")
ALLOWED_MODELS = {"htdemucs", "htdemucs_ft", "htdemucs_6s"}

# Parenthetical/bracketed suffixes to strip before parsing: (Letra), [Official Video], etc.
_SUFFIX_RE = re.compile(r'\s*[\(\[][^\)\]]*[\)\]]')
# Common filler words channels append after a dash that aren't an artist name
_FILLER = {"official video", "official audio", "official music video", "lyrics",
           "lyric video", "audio", "hd", "hq", "letra", "subtitulado"}


def safe_stem(filename: str) -> str:
    return re.sub(r"[^\w\-]", "_", Path(filename).stem)


def _parse_yt_title(raw_title: str, channel: str) -> tuple[str, str]:
    """
    Split a YouTube video title into (artist, song_title).
    Common patterns:
      "Camila - Todo Cambió (Letra)"     → ("Camila", "Todo Cambió")
      "Todo Cambió - Camila"             → ("Camila", "Todo Cambió")
      "Sin Bandera - Suelta Mi Mano"     → ("Sin Bandera", "Suelta Mi Mano")
    Falls back to returning (channel, cleaned_title) when no dash found.
    """
    # Strip parentheticals/brackets first
    clean = _SUFFIX_RE.sub("", raw_title).strip()

    if " - " in clean:
        left, right = clean.split(" - ", 1)
        left, right = left.strip(), right.strip()
        # If the right side looks like filler, swap
        if right.lower() in _FILLER:
            left, right = right, left
        return left, right

    # No dash: use raw title as song title, channel as artist hint
    return channel, clean or raw_title


@router.get("/api/youtube/metadata")
async def youtube_metadata(url: str):
    """Fetch title/artist for a YouTube URL using the free oEmbed API (no auth needed)."""
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
    source_path = job_dir / f"source{ext}"

    content = await file.read()
    source_path.write_bytes(content)

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
