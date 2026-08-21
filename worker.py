#!/usr/bin/env python3
"""
Guitar Practice Tool — Processing Worker

Run on Mac for fast processing or on the home server for slower CPU processing.

Usage:
  python worker.py --server http://192.168.1.5:8000 --device mps   # Mac (fast)
  python worker.py --server http://localhost:8000 --device cpu       # Server (slow)

--server and --device default to $JAMMATE_SERVER and $JAMMATE_DEVICE, so set those
once in your shell profile and ./worker.sh needs no arguments.

Dependencies: pip install -r requirements.txt

The worker polls for pending jobs, processes them (Demucs → Opus transcode),
uploads results, and marks the job done.
"""
import argparse
import json as _json
import os
import platform
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
_ALIGNER = Path(__file__).parent / "lyric_align.py"
_CIFRA_ATTEMPTS = 2       # a transient network failure shouldn't cost the sheet
_CIFRA_BACKOFF = 1.5      # seconds
_LYRICS_ATTEMPTS = 2      # the server already retries 3× per endpoint underneath
_LYRICS_BACKOFF = 1.5     # seconds
_SESSION = requests.Session()
_SESSION.headers.update({"Content-Type": "application/json"})

# Set from the CLI in main(); both poll branches need them, and threading them
# through every call just to reach _align_lyrics buys nothing.
_ALIGN_MODEL = "small"
_ALIGN_DEVICE = "cpu"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _patch(server: str, job_id: str, **kwargs):
    try:
        _SESSION.patch(f"{server}/api/jobs/{job_id}", json=kwargs, timeout=15)
    except Exception as e:
        print(f"[worker] patch failed: {e}", flush=True)


def _fetch_cifra_sheet(server: str, job_id: str) -> bool:
    """Ask the server to find and import a Cifra Club sheet for this song.

    Posting an empty URL makes the endpoint auto-search by artist + title, and it
    writes chord_sheet itself — so the parsing and ad-stripping live in one place.
    Never fatal: no sheet just means the user imports one by hand later.
    """
    for attempt in range(1, _CIFRA_ATTEMPTS + 1):
        try:
            r = _SESSION.post(
                f"{server}/api/jobs/{job_id}/fetch-cifra", json={"url": ""}, timeout=45
            )
            if r.status_code == 200:
                return True
            # 404 = not on Cifra Club, 422 = page had no chords. Neither improves
            # by asking again, so don't waste the song's processing time on it.
            if r.status_code in (404, 422):
                print(f"[worker] no Cifra sheet: {r.json().get('error', r.status_code)}", flush=True)
                return False
            reason = f"HTTP {r.status_code}"
        except Exception as e:
            reason = str(e) or e.__class__.__name__
        if attempt < _CIFRA_ATTEMPTS:
            time.sleep(_CIFRA_BACKOFF)
        else:
            print(f"[worker] Cifra fetch failed: {reason}", flush=True)
    return False


def _fetch_lyrics(server: str, job_id: str) -> str:
    """Ask the server to look up lyrics on LRCLIB. Returns synced|plain|none.

    Delegated rather than done here — the server's _lrclib_lookup does 2 endpoints
    × 3 attempts with backoff, checks *every* result for synced lyrics, and above
    all tells a network failure (502) apart from a genuine miss (404). That
    distinction is exactly what decides whether local alignment should run, and
    duplicating a weaker version of it here is how songs ended up with no lyrics
    at all after one flaky request.
    """
    for attempt in range(1, _LYRICS_ATTEMPTS + 1):
        try:
            r = _SESSION.post(f"{server}/api/jobs/{job_id}/fetch-lyrics", timeout=60)
            if r.status_code == 200:
                return "synced" if r.json().get("synced") else "plain"
            # 404 = not on LRCLIB, 422 = the song has no title to search with.
            # Neither improves by asking again; both mean "align it locally".
            if r.status_code in (404, 422):
                print(f"[worker] no LRCLIB lyrics: {r.json().get('error', r.status_code)}",
                      flush=True)
                return "none"
            reason = f"HTTP {r.status_code}"
        except Exception as e:
            reason = str(e) or e.__class__.__name__
        if attempt < _LYRICS_ATTEMPTS:
            time.sleep(_LYRICS_BACKOFF)
        else:
            print(f"[worker] lyrics fetch failed: {reason}", flush=True)
    return "none"


def _get_job(server: str, job_id: str) -> dict:
    r = _SESSION.get(f"{server}/api/jobs/{job_id}", timeout=15)
    r.raise_for_status()
    return r.json()


def _heartbeat(server: str, name: str = "", device: str = ""):
    # Named so two workers sharing a server don't overwrite each other's status.
    try:
        _SESSION.post(f"{server}/api/settings/worker-heartbeat",
                      json={"name": name, "device": device}, timeout=5)
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
# Duration + Lyrics + BPM
# ---------------------------------------------------------------------------

def _get_duration(source_path: Path) -> float | None:
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(source_path)],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        try:
            return float(_json.loads(r.stdout)["format"]["duration"])
        except (KeyError, ValueError):
            pass
    return None


def _detect_bpm(drums_path: Path) -> tuple[float | None, list[float]]:
    """
    Detect BPM and beat timestamps using ffmpeg + numpy.
    Decodes the drums stem to mono 22050 Hz PCM, computes onset strength,
    finds tempo via autocorrelation, then picks beats.
    """
    try:
        import numpy as np

        SR = 22050
        HOP = 512  # ~23 ms per frame

        # Decode to raw float32 PCM via ffmpeg
        r = subprocess.run(
            ["ffmpeg", "-i", str(drums_path), "-f", "f32le", "-ar", str(SR), "-ac", "1", "pipe:1", "-loglevel", "quiet"],
            capture_output=True,
        )
        if r.returncode != 0 or not r.stdout:
            return None, []

        audio = np.frombuffer(r.stdout, dtype=np.float32)
        n_frames = len(audio) // HOP

        # Compute RMS energy per hop frame
        energy = np.array([
            np.sqrt(np.mean(audio[i * HOP:(i + 1) * HOP] ** 2))
            for i in range(n_frames)
        ])

        # Onset strength: positive first-difference of energy (half-rectified)
        onset = np.diff(energy, prepend=energy[0])
        onset = np.maximum(onset, 0)

        # Find dominant period via autocorrelation over BPM range 60–200
        fps = SR / HOP
        min_lag = int(fps * 60 / 200)  # 200 BPM
        max_lag = int(fps * 60 / 60)   # 60 BPM

        if max_lag >= len(onset):
            return None, []

        # Autocorrelation
        corr = np.correlate(onset, onset, mode='full')
        corr = corr[len(corr) // 2:]
        search = corr[min_lag:max_lag + 1]
        best_lag = int(np.argmax(search)) + min_lag
        bpm = fps * 60 / best_lag

        # Generate beat timestamps spaced by best_lag frames
        # Anchor to the strongest onset in the first 4 bars
        anchor_end = min(best_lag * 8, len(onset))
        first_anchor = int(np.argmax(onset[:anchor_end]))
        beat_frames = []
        # Walk backward from anchor
        t = first_anchor
        while t >= 0:
            beat_frames.append(t)
            t -= best_lag
        # Walk forward from anchor
        t = first_anchor + best_lag
        total_frames = len(audio) // HOP
        while t < total_frames:
            beat_frames.append(t)
            t += best_lag

        beat_times = sorted(float(f * HOP / SR) for f in beat_frames if f >= 0)
        return round(bpm, 1), beat_times

    except Exception as e:
        print(f"[worker] BPM detection failed: {e}", flush=True)
        return None, []


# ---------------------------------------------------------------------------
# Local lyric alignment
# ---------------------------------------------------------------------------

def _align_text(job: dict) -> tuple[list[str], str] | None:
    """Pick what to align against, and record where it came from.

    LRCLIB's plain lyrics win over the chord sheet: a sheet writes the chorus once
    and collapses repeats to "(x2)", so text that skips a repeated chorus drifts
    from that point on. That is the biggest accuracy risk in this whole path.
    """
    from sheet_parse import plain_lyric_lines, sheet_lyric_lines

    if job.get("chord_source") == "lrclib-plain" and job.get("chord_data"):
        return plain_lyric_lines(job["chord_data"]), "lrclib-plain"
    if job.get("chord_sheet"):
        # A sheet with no source URL was pasted in by hand
        source = "cifra" if job.get("chord_source_url") else "manual"
        return sheet_lyric_lines(job["chord_sheet"]), source
    return None


def _align_lyrics(server: str, job_id: str, vocals_path: Path, work_dir: Path) -> bool:
    """Time the song's own lyrics against its vocals stem. Never fatal.

    Shells out the same way Demucs does, so a torch crash or an OOM can't take the
    poll loop with it.
    """
    from sheet_parse import align_pairs

    if not vocals_path.exists():
        print("[worker] vocals stem not found, skipping alignment", flush=True)
        _patch(server, job_id, align_status="error")
        return False

    job = _get_job(server, job_id)
    picked = _align_text(job)
    if not picked:
        print("[worker] nothing to align (no lyrics text)", flush=True)
        return False
    lines, text_source = picked

    pairs = align_pairs(lines)
    if not pairs:
        print("[worker] no alignable lines after cleaning", flush=True)
        return False

    text_file = work_dir / "align_clean.txt"
    orig_file = work_dir / "align_original.txt"
    out_file = work_dir / "align_result.json"
    text_file.write_text("\n".join(c for _, c in pairs), encoding="utf-8")
    orig_file.write_text("\n".join(o.strip() for o, _ in pairs), encoding="utf-8")

    cmd = [
        sys.executable, str(_ALIGNER),
        "--audio", str(vocals_path),
        "--text", str(text_file),
        "--original", str(orig_file),
        "--out", str(out_file),
        "--lang", "auto",
        "--model", _ALIGN_MODEL,
        "--device", _ALIGN_DEVICE,
    ]
    print(f"[worker] aligning {len(pairs)} lines from {text_source} "
          f"({_ALIGN_MODEL} on {_ALIGN_DEVICE})…", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.stderr:
        print(result.stderr.strip(), flush=True)
    if result.returncode != 0 or not out_file.exists():
        print(f"[worker] alignment failed (exit {result.returncode})", flush=True)
        _patch(server, job_id, align_status="error")
        return False

    data = _json.loads(out_file.read_text(encoding="utf-8"))
    if not data.get("lrc"):
        _patch(server, job_id, align_status="error")
        return False

    # A weak score is kept and used anyway — it's still better than constant-rate
    # autoscroll. The score gates submitting the result anywhere, not using it.
    _patch(server, job_id,
           chord_data=data["lrc"],
           chord_source="aligned",
           align_status="done",
           align_score=data.get("score") or 0.0,
           align_text_source=text_source)
    print(f"[worker] aligned {data.get('aligned')}/{data.get('lines')} lines, "
          f"score {data.get('score')}", flush=True)
    return True


def _download_stem(server: str, job_id: str, stem_file: str, dest_dir: Path) -> Path:
    r = _SESSION.get(f"{server}/api/audio/{job_id}/{stem_file}", stream=True, timeout=180)
    r.raise_for_status()
    dest = dest_dir / stem_file
    with open(dest, "wb") as f:
        for chunk in r.iter_content(chunk_size=65536):
            f.write(chunk)
    return dest


def _process_align_job(server: str, job: dict):
    """The manual re-run path: only vocals.ogg is needed, so no Demucs re-run."""
    job_id = job["id"]
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        vocals = _download_stem(server, job_id, "vocals.ogg", tmp_path)
        if not _align_lyrics(server, job_id, vocals, tmp_path):
            # Whatever went wrong, align_status must not be left at 'running' or
            # the song sits in the queue as claimed-but-never-finished forever.
            _patch(server, job_id, align_status="error")


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
        # status='processing' was already set atomically when the server handed us
        # the job. Every _patch from here also refreshes updated_at, which is what
        # lets the server reclaim this job if we die mid-run.
        _patch(server, job_id, progress=0, progress_phase="Downloading source…")

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

        # ── Step 4: Extract duration + fetch lyrics ───────────────────────
        _patch(server, job_id, progress=88, progress_phase="Fetching lyrics…")
        duration = _get_duration(source_path)
        # Written before the lookup, not with the final done_patch: the server's
        # strict /api/get match needs duration_sec, and a NULL there silently
        # downgrades every song to the fuzzy /api/search endpoint.
        if duration is not None:
            _patch(server, job_id, duration_sec=duration)
        lyrics_state = _fetch_lyrics(server, job_id)
        print(f"[worker] lyrics: {lyrics_state}", flush=True)

        # ── Step 5: Import the Cifra Club chord sheet ─────────────────────
        _patch(server, job_id, progress=90, progress_phase="Fetching chords…")
        if _fetch_cifra_sheet(server, job_id):
            print("[worker] Cifra sheet imported", flush=True)

        # ── Step 6: Align lyrics locally ──────────────────────────────────
        # After Cifra on purpose: the sheet is what supplies the alignment text
        # when LRCLIB had nothing synced. vocals.ogg is already local from Step 3,
        # the same way drums.ogg is reused for BPM below.
        if lyrics_state == "synced":
            print("[worker] LRCLIB has synced lyrics — skipping alignment", flush=True)
        else:
            _patch(server, job_id, progress=92, progress_phase="Aligning lyrics…")
            try:
                _align_lyrics(server, job_id, tmp_path / "vocals.ogg", tmp_path)
            except Exception as e:
                print(f"[worker] alignment failed: {e}", flush=True)
                _patch(server, job_id, align_status="error")

        # ── Step 7: Detect BPM from drums stem ────────────────────────────
        bpm = None
        beat_times: list[float] = []
        drums_ogg = tmp_path / "drums.ogg"
        if drums_ogg.exists():
            _patch(server, job_id, progress=97, progress_phase="Detecting tempo…")
            bpm, beat_times = _detect_bpm(drums_ogg)
            if bpm:
                print(f"[worker] BPM detected: {bpm:.1f} ({len(beat_times)} beats)", flush=True)
            else:
                print("[worker] BPM detection returned no result", flush=True)
        else:
            print("[worker] drums stem not found, skipping BPM detection", flush=True)

        # ── Step 8: Mark done ─────────────────────────────────────────────
        # chord_data/chord_source are no longer carried through here — the
        # fetch-lyrics endpoint and the aligner each write them directly, so
        # repeating them would overwrite whichever ran last with stale values.
        done_patch: dict = {"status": "done", "progress": 100, "progress_phase": "Done"}
        if bpm:
            done_patch["bpm"] = bpm
            done_patch["beat_times"] = _json.dumps(beat_times)
        _patch(server, job_id, **done_patch)
        print(f"[worker] job {job_id} complete ✓", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Guitar Practice Tool — Worker")
    # Defaults from the environment so the Mac worker — which points at the home
    # server, not at localhost — doesn't need the URL retyped on every run.
    parser.add_argument("--server", default=os.environ.get("JAMMATE_SERVER", "http://localhost:8000"),
                        help="Server base URL, e.g. http://192.168.1.5:8000 "
                             "(default: $JAMMATE_SERVER, else http://localhost:8000)")
    parser.add_argument("--device", default=os.environ.get("JAMMATE_DEVICE", "cpu"),
                        choices=["mps", "cpu", "cuda"],
                        help="Torch device for Demucs (default: $JAMMATE_DEVICE, else cpu)")
    parser.add_argument("--name", default=os.environ.get("JAMMATE_WORKER_NAME") or platform.node(),
                        help="Worker name shown in Settings (default: this machine's hostname)")
    parser.add_argument("--align-model", default=os.environ.get("JAMMATE_ALIGN_MODEL", "small"),
                        help="Whisper model for lyric alignment (default: $JAMMATE_ALIGN_MODEL, else small)")
    # Whisper on MPS hits unimplemented sparse ops, so this deliberately does not
    # follow --device. A 4-minute vocals stem on `small` is about a minute on CPU.
    parser.add_argument("--align-device", default=os.environ.get("JAMMATE_ALIGN_DEVICE", "cpu"),
                        choices=["mps", "cpu", "cuda"],
                        help="Torch device for lyric alignment (default: $JAMMATE_ALIGN_DEVICE, else cpu)")
    parser.add_argument("--poll-interval", type=int, default=10,
                        help="Seconds between polls when idle")
    args = parser.parse_args()

    global _ALIGN_MODEL, _ALIGN_DEVICE
    _ALIGN_MODEL = args.align_model
    _ALIGN_DEVICE = args.align_device

    server = args.server.rstrip("/")
    device = args.device
    name = args.name
    print(f"[worker] starting — server={server} device={device} name={name} "
          f"align={_ALIGN_MODEL}/{_ALIGN_DEVICE}", flush=True)

    while True:
        _heartbeat(server, name, device)
        try:
            # ── Full processing jobs ───────────────────────────────────────
            # The server claims the job atomically and hands back the row, so two
            # workers can share one server without separating the same song twice.
            # Passing our device lets it prefer the machine chosen in Settings.
            r = _SESSION.get(f"{server}/api/jobs/pending",
                             params={"device": device, "worker": name}, timeout=15)
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

            # ── Lyric alignment re-runs ────────────────────────────────────
            # A separate, lightweight queue: source audio isn't retained, so
            # re-queueing a done song as 'pending' would mean a full Demucs
            # re-run just to fix its lyrics. Only vocals.ogg is needed here.
            r = _SESSION.get(f"{server}/api/jobs/pending-align",
                             params={"worker": name}, timeout=15)
            # A server too old to know this route isn't unreachable — separation
            # still works, so say nothing and keep polling the main queue.
            job = r.json().get("job") if r.status_code == 200 else None
            if job:
                jid = job["id"]
                print(f"[worker] aligning lyrics for {jid}: '{job.get('title', '?')}'",
                      flush=True)
                try:
                    _process_align_job(server, job)
                except Exception as e:
                    print(f"[worker] alignment job {jid} FAILED: {e}", flush=True)
                    _patch(server, jid, align_status="error")
                continue

        except requests.RequestException as e:
            print(f"[worker] server unreachable: {e}", flush=True)
        except Exception as e:
            print(f"[worker] unexpected error: {e}", flush=True)

        time.sleep(args.poll_interval)


if __name__ == "__main__":
    main()
