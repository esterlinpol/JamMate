#!/usr/bin/env python3
"""
Guitar Practice Tool — Processing Worker

Run on Mac for fast processing or on the home server for slower CPU processing.

Usage:
  python worker.py --server http://192.168.1.5:8000 --device mps   # Mac (fast)
  python worker.py --server http://localhost:8000 --device cpu       # Server (slow)

Dependencies: pip install -r requirements.txt

The worker polls for pending jobs, processes them (Demucs → Opus transcode),
uploads results, and marks the job done.
"""
import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import certifi
import requests

os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

_RUNNER = Path(__file__).parent / "demucs_runner.py"
_SESSION = requests.Session()
_SESSION.headers.update({"Content-Type": "application/json"})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _patch(server: str, job_id: str, **kwargs):
    try:
        _SESSION.patch(f"{server}/api/jobs/{job_id}", json=kwargs, timeout=15)
    except Exception as e:
        print(f"[worker] patch failed: {e}", flush=True)


def _heartbeat(server: str):
    try:
        _SESSION.post(f"{server}/api/settings/worker-heartbeat", timeout=5)
    except Exception:
        pass


def _download_source(server: str, job_id: str, dest_dir: Path) -> Path:
    r = _SESSION.get(f"{server}/api/audio/{job_id}/source", stream=True, timeout=120)
    r.raise_for_status()

    ext = ".mp3"
    cd = r.headers.get("content-disposition", "")
    if "filename=" in cd:
        fname = cd.split("filename=")[-1].strip().strip('"')
        ext = Path(fname).suffix or ".mp3"

    dest = dest_dir / f"source{ext}"
    with open(dest, "wb") as f:
        for chunk in r.iter_content(chunk_size=65536):
            f.write(chunk)
    return dest


def _download_youtube(url: str, dest_dir: Path) -> tuple[Path, str, str]:
    import yt_dlp

    outtmpl = str(dest_dir / "source.%(ext)s")
    opts = {
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)

    title = info.get("title", "") or ""
    artist = info.get("uploader", "") or ""
    # yt-dlp writes source.mp3 after postprocessing
    mp3 = dest_dir / "source.mp3"
    if not mp3.exists():
        # fallback: find whatever was written
        for f in dest_dir.iterdir():
            if f.stem == "source":
                return f, title, artist
    return mp3, title, artist


# ---------------------------------------------------------------------------
# Demucs
# ---------------------------------------------------------------------------

def _run_demucs(source_path: Path, out_dir: Path, device: str):
    cmd = [
        sys.executable, str(_RUNNER),
        "--device", device,
        "-n", "htdemucs_6s",
        "--out", str(out_dir),
        str(source_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-2000:] if result.stderr else "(no stderr)"
        raise RuntimeError(f"Demucs failed (exit {result.returncode}):\n{tail}")


def _find_wav_stems(out_dir: Path) -> dict[str, Path]:
    """Walk Demucs output tree and return {stem_name: Path} for all WAVs."""
    stems: dict[str, Path] = {}
    for model_dir in out_dir.iterdir():
        if not model_dir.is_dir():
            continue
        for song_dir in model_dir.iterdir():
            if not song_dir.is_dir():
                continue
            for f in song_dir.iterdir():
                if f.suffix == ".wav":
                    stems[f.stem] = f
    if not stems:
        raise RuntimeError("No stems found after Demucs")
    return stems


# ---------------------------------------------------------------------------
# Transcoding
# ---------------------------------------------------------------------------

def _transcode_to_opus(wav_path: Path, ogg_path: Path):
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(wav_path),
         "-c:a", "libopus", "-b:a", "128k", str(ogg_path)],
        capture_output=True, check=True,
    )


def _upload_stem(server: str, job_id: str, stem_name: str, ogg_path: Path):
    with open(ogg_path, "rb") as f:
        resp = requests.post(
            f"{server}/api/jobs/{job_id}/stems/{stem_name}.ogg",
            data=f,
            headers={"Content-Type": "audio/ogg"},
            timeout=300,
        )
    resp.raise_for_status()


# ---------------------------------------------------------------------------
# Main processing loop
# ---------------------------------------------------------------------------

def _process_job(server: str, job: dict, device: str):
    job_id = job["id"]
    source_type = job.get("source_type", "upload")
    title = job.get("title", "")
    artist = job.get("artist", "")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        demucs_out = tmp_path / "separated"
        demucs_out.mkdir()

        # ── Step 1: Acquire source audio ──────────────────────────────────
        _patch(server, job_id, status="processing", progress=0,
               progress_phase="Downloading source…")

        if source_type == "youtube":
            _patch(server, job_id, progress_phase="Downloading from YouTube…")
            source_path, yt_title, yt_artist = _download_youtube(
                job["source_url"], tmp_path
            )
            if yt_title and not title:
                title = yt_title
                _patch(server, job_id, title=yt_title, artist=yt_artist)
                artist = yt_artist
        else:
            source_path = _download_source(server, job_id, tmp_path)

        # ── Step 2: Demucs separation ──────────────────────────────────────
        _patch(server, job_id, progress=8,
               progress_phase=f"Separating stems ({device.upper()})…")
        print(f"[worker] running Demucs on {device}…", flush=True)
        _run_demucs(source_path, demucs_out, device)

        wav_stems = _find_wav_stems(demucs_out)
        stem_names = sorted(wav_stems.keys())
        print(f"[worker] found stems: {stem_names}", flush=True)

        # ── Step 3: Transcode WAV → Opus + upload ─────────────────────────
        for i, name in enumerate(stem_names):
            pct = 40 + int((i / len(stem_names)) * 30)
            _patch(server, job_id, progress=pct,
                   progress_phase=f"Encoding {name}…")
            ogg_path = tmp_path / f"{name}.ogg"
            _transcode_to_opus(wav_stems[name], ogg_path)
            _upload_stem(server, job_id, name, ogg_path)
            print(f"[worker] uploaded {name}.ogg", flush=True)

        # ── Step 4: Mark done ─────────────────────────────────────────────
        _patch(server, job_id, status="done", progress=100, progress_phase="Done")
        print(f"[worker] job {job_id} complete ✓", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Guitar Practice Tool — Worker")
    parser.add_argument("--server", required=True,
                        help="Server base URL, e.g. http://192.168.1.5:8000")
    parser.add_argument("--device", default="cpu",
                        choices=["mps", "cpu", "cuda"],
                        help="Torch device for Demucs")
    parser.add_argument("--poll-interval", type=int, default=10,
                        help="Seconds between polls when idle")
    args = parser.parse_args()

    server = args.server.rstrip("/")
    device = args.device
    print(f"[worker] starting — server={server} device={device}", flush=True)

    while True:
        _heartbeat(server)
        try:
            # ── Full processing jobs ───────────────────────────────────────
            r = _SESSION.get(f"{server}/api/jobs/pending", timeout=15)
            r.raise_for_status()
            job = r.json().get("job")
            if job:
                jid = job["id"]
                print(f"[worker] picked up job {jid}: '{job.get('title', '?')}'", flush=True)
                try:
                    _process_job(server, job, device)
                except Exception as e:
                    print(f"[worker] job {jid} FAILED: {e}", flush=True)
                    try:
                        _patch(server, jid, status="error", error_msg=str(e)[:500])
                    except Exception:
                        pass
                continue  # check for more work immediately

        except requests.RequestException as e:
            print(f"[worker] server unreachable: {e}", flush=True)
        except Exception as e:
            print(f"[worker] unexpected error: {e}", flush=True)

        time.sleep(args.poll_interval)


if __name__ == "__main__":
    main()
