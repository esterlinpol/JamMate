# JamMate

A personal guitar practice companion. Paste a YouTube link or upload an audio file and JamMate separates it into individual stems (drums, bass, guitar, piano, vocals, other) so you can mute the guitar track and play along, slow down with specific stems, or isolate any instrument you want to learn.

## What it does today

- **Stem separation** via [Demucs](https://github.com/facebookresearch/demucs) (`htdemucs_6s` — 6 stems)
- **YouTube support** — paste a URL and yt-dlp handles the download
- **Per-stem controls** — individual volume sliders, mute, and solo
- **Synchronized playback** — all stems start and stop together via the Web Audio API
- **Mobile-friendly UI** — single-page HTML/JS with Tailwind CSS, works on phone

## Architecture

```
Browser  ←→  FastAPI server (app/)  ←→  SQLite (data/songs.db)
                                              ↑
                                        Worker (worker.py)
                                    runs Demucs + ffmpeg separately
```

The server is lightweight — it handles uploads, the job queue, and serves the frontend. The worker is a separate process that does the heavy lifting (Demucs inference, Opus transcoding, stem upload). The worker can run on the same machine or on a remote server/NAS.

## Requirements

- Python 3.10+
- [ffmpeg](https://ffmpeg.org/) in `$PATH`
- Apple Silicon (MPS), CUDA GPU, or CPU (slow)

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Running

**Start the server:**
```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**Start the worker** (same machine, Apple Silicon):
```bash
python worker.py --server http://localhost:8000 --device mps
```

**Worker on a remote CPU server:**
```bash
python worker.py --server http://192.168.1.x:8000 --device cpu
```

The worker polls `/api/jobs/pending` every 10 seconds by default (`--poll-interval`). Once a job is picked up it runs Demucs, transcodes each stem to Opus, uploads the files, and marks the job done.

## Demucs models

| Model | Stems | Notes |
|---|---|---|
| `htdemucs_6s` | drums, bass, guitar, piano, vocals, other | Default — best for guitar practice |
| `htdemucs` | drums, bass, vocals, other | Faster |
| `htdemucs_ft` | drums, bass, vocals, other | Fine-tuned, higher quality |

## Data layout

```
data/
  songs.db          — SQLite job database
  uploads/<job_id>/ — original source audio
  separated/<job_id>/ — Opus-encoded stems (.ogg)
```

## Personal use notice

JamMate is built for personal practice with music you own or have the right to use. Downloading audio from YouTube via yt-dlp may violate YouTube's Terms of Service and, depending on your country, copyright law. Only use the YouTube feature with content you are legally allowed to download — for example, your own uploads, royalty-free tracks, or content explicitly licensed for download.

This project is not intended for distribution, redistribution of audio, or any commercial purpose.

## Roadmap

- [ ] Lyrics sync display
- [ ] Per-measure chord display (Chordify-style blocks)
- [ ] Capo transposition UI
- [ ] Playback speed control

## Tech stack

- **Backend**: FastAPI, SQLite (WAL mode), aiofiles
- **Worker**: Demucs, yt-dlp, ffmpeg (via subprocess), requests
- **Frontend**: Vanilla JS, Web Audio API, Tailwind CSS (CDN)
