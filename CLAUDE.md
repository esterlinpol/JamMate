# JamMate — Project Reference for Claude

## What This Is
JamMate is a local web app for musicians. You upload or import a song (YouTube or audio file), it splits it into stems (vocals, guitar, bass, drums, piano, other) using Demucs, and lets you:
- Play/mute/solo individual stems, with volume and tempo steppers
- Display a chord + lyric sheet imported from Cifra Club (or pasted manually), synced to the song
- Display plain lyrics (LRC) in a karaoke-style scrolling view
- Detect BPM

---

## How to Run
```bash
# Start the FastAPI server
uvicorn app.main:app --reload

# Start the Demucs worker (separate terminal)
./worker.sh
```
- App runs at `http://localhost:8000`
- Worker polls `/api/jobs/pending` and processes songs via `worker.py` + `demucs_runner.py`
- Stems stored under `data/separated/{job_id}/`
- Uploads stored under `data/uploads/`
- Database: `data/songs.db` (SQLite)

---

## Stack
| Layer | Tech |
|---|---|
| Backend | Python, FastAPI, SQLite |
| Templating | JinjaX (HTML components in `components/`) |
| Frontend | Vanilla JS (ES modules), Tailwind CSS (CDN) |
| Stem separation | Demucs (`htdemucs_6s` default) |
| BPM detection | Custom autocorrelation on drums stem via NumPy |

---

## File Index

### Backend
| File | Purpose |
|---|---|
| `app/main.py` | FastAPI app, mounts routes, serves `Layout.html` at `/` |
| `app/routes.py` | All API endpoints (see section below) |
| `app/db.py` | SQLite schema, migrations, `init_db()`, default chord seeding |
| `worker.py` | Background job loop: polls pending jobs, calls Demucs |
| `demucs_runner.py` | Wrapper that runs Demucs and writes stems |
| `worker.sh` | Shell script to start the worker |

### Frontend — HTML Components (JinjaX)
| File | Purpose |
|---|---|
| `components/Layout.html` | Root shell: loads Tailwind, imports `ui.js`, renders all views |
| `components/Player.html` | Player view: header, lyrics/chord-sheet area, stems, transport, actions sheet |
| `components/Library.html` | Song list / home screen |
| `components/AddSheet.html` | Add song form (upload or YouTube URL) |
| `components/Settings.html` | Settings panel (worker device, etc.) |

### Frontend — JavaScript (`static/js/`)
| File | Purpose |
|---|---|
| `ui.js` | Main controller: wires all DOM events, manages view transitions, chord-sheet modal, BPM detect |
| `player.js` | Web Audio API multi-stem player: play/pause/seek/volume/mute/solo/tempo |
| `chords.js` | Chord sheet + lyrics display: LRC parsing, chord-sheet parsing/alignment, Spotify-style scroll |
| `wake-lock.js` | Keeps the screen awake during playback (Wake Lock API + silent-video fallback) |

### Frontend — CSS
| File | Purpose |
|---|---|
| `static/css/app.css` | All custom styles (Tailwind handles utilities; this has the `.cs-*` chord sheet, steppers, etc.) |

---

## Database Schema (`data/songs.db`)

### `jobs` table (one row per song)
```
id, title, artist, filename, source_type (upload|youtube), source_url,
status (pending|processing|done|error), model, shifts,
stem_base, chord_data, chord_source, chord_source_url, capo,
duration_sec, progress, progress_phase, error_msg,
created_at, updated_at,
chord_sheet,       -- chord + lyric text imported from Cifra Club or pasted manually
bpm,               -- detected float, shown as a badge in the player header
scroll_speed,      -- int %: autoscroll rate, 100 = sheet ends exactly with the song
-- Dormant: written but no longer read by the UI (the beat-grid chord editor was
-- removed; columns kept so the feature can return without a migration)
song_chord_data,   -- LRC-format chord timeline: [MM:SS.ss]ChordName\n...
beat_times,        -- JSON array of beat timestamps (seconds, uniform spacing)
beat_offset,       -- float: seconds shift applied to all beat_times
bar_offset         -- int 0-3: which beat index is beat 1 of bar 1
```

### `chords` table (dormant — chord shape library, no longer read; kept for a possible return)
```
id, name (unique), frets (JSON [6 ints]), fingers (JSON [6 ints]), barre (JSON|null),
created_at, updated_at
```
- `frets`: -1=muted, 0=open, 1+=fret number
- `barre`: `{"fret": N, "from": 0, "to": 5}` or null

### `settings` table
```
key, value   -- worker_device (cpu|cuda|mps), preferred_chord_source, worker_last_seen
```

---

## API Endpoints (`app/routes.py`)

### Jobs
| Method | Path | Notes |
|---|---|---|
| GET | `/api/jobs` | List all songs |
| GET | `/api/jobs/pending` | Worker polls this |
| GET | `/api/jobs/{id}` | Single job |
| PATCH | `/api/jobs/{id}` | Update any field in `JobPatch` model |
| DELETE | `/api/jobs/{id}` | Delete job + stems |
| POST | `/api/upload` | Upload audio file → creates job |
| POST | `/api/youtube` | Add YouTube URL → creates job |
| GET | `/api/youtube/metadata` | Fetch title/artist from yt-dlp |

### Stems & Audio
| Method | Path | Notes |
|---|---|---|
| GET | `/api/stems/{job_id}` | Returns stem file list + all song metadata |
| POST | `/api/jobs/{id}/source` | Upload raw audio |
| GET | `/api/audio/{id}/source` | Stream source audio |
| GET | `/api/audio/{id}/{stem_file}` | Stream a stem (supports Range) |
| POST | `/api/jobs/{id}/stems/{name}` | Upload individual stem |

### BPM
| Method | Path | Notes |
|---|---|---|
| POST | `/api/jobs/{id}/detect-bpm` | Runs autocorrelation on drums stem, stores `bpm` + `beat_times` |

BPM detection logic (in `routes.py:detect_bpm`):
1. Decode drums stem to raw float32 via ffmpeg
2. Compute RMS energy per hop → onset signal
3. Autocorrelation to find dominant beat period (lag)
4. If detected BPM > 120, check half-tempo candidate — prefer it if its correlation score ≥ 60% of the peak (prevents double-time detection)
5. Generate **uniform** beat grid: `phase = anchor_time % beat_interval`, then `t += beat_interval` in float-seconds (no frame rounding)

### Chord sheet
| Method | Path | Notes |
|---|---|---|
| POST | `/api/jobs/{id}/fetch-cifra` | Fetch + parse a Cifra Club page into `chord_sheet` (auto-searches by artist/title if no URL given) |

A sheet can also be pasted manually and saved via `PATCH /api/jobs/{id}` with `chord_sheet`.
Both paths run `strip_cifra_ads()` — see Known Behaviours.

### Lyrics (LRCLIB)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/jobs/{id}/fetch-lyrics` | Re-fetch lyrics from LRCLIB into `chord_data` + `chord_source` |

`worker.py` fetches lyrics once during processing (`_fetch_lrclib`), so a transient
failure there left a song permanently without lyrics. This endpoint is the retry:
the Lyrics tile in the actions sheet calls it, and the tile's label becomes `RETRY`
on failure so tapping again tries once more.

- Tries `/api/get` (needs `duration_sec`) then `/api/search`, `_LYRICS_ATTEMPTS`
  attempts each with `_LYRICS_BACKOFF`; a 404 is a genuine miss and is not retried
- `_lrclib_pick()` scans **all** results for synced lyrics before settling for plain
  ones (`worker.py` only ever looked at the first result)
- Declared `def`, not `async def`, so FastAPI runs it in a threadpool — the retry
  sleeps would otherwise stall stem streaming for the player that asked

### Autoscroll (fallback when there are no timestamps)
When nothing in the view carries a timestamp — a Cifra sheet with no matching LRC,
or plain (unsynced) lyrics — the panel is scrolled straight from playback position
instead of following timestamps. `needsAutoscroll()` in `chords.js` detects that
case and the Autoscroll row in the actions sheet turns itself on.

- Position is **derived** from elapsed time, never accumulated:
  `scrollTop = (t / duration) * scrollRange * (speed/100) + manualOffset`, so seek,
  pause and tempo changes need no special handling
- `speed` is a % where 100 reaches the end of the sheet exactly as the song ends,
  persisted per song in `jobs.scroll_speed` (debounced PATCH, `AS_STEP` = 5)
- Dragging the panel is treated as a deliberate nudge: the delta is kept in
  `asManualOffset` and applied from then on. Our own writes are told apart from the
  user's by comparing against `asLastSet`
- While it runs, the timestamp-driven scrolls (`centerChordSheetSection`,
  Spotify's `scrollIntoView`) are skipped so the two can't fight
- `#lyrics-*-panel.as-active` drops `scroll-behavior` to `auto` — smooth scrolling
  would animate every per-frame write and lag behind

---

## Chord Sheet System

The only chord UI is the imported/pasted chord + lyric sheet. The beat-grid strip,
chord-shape diagrams, timeline editor, bulk beat import, and chord library were
removed (see git history before this commit if they need to come back).

### Source
- **Cifra Club import** — `POST /api/jobs/{id}/fetch-cifra`, parsed by `_parse_cifra_page()`
  in `routes.py` (picks the `<pre>` block richest in chord tokens)
- **Automatic, during processing** — `worker.py` step 5 posts to that endpoint with an
  empty URL, so a new song arrives with its sheet already imported. Non-fatal: 404
  (not on Cifra Club) and 422 (page had no chords) give up immediately, network
  errors get `_CIFRA_ATTEMPTS` tries. The worker deliberately calls the endpoint
  rather than parsing itself, so auto-search and ad-stripping stay in one place
- **Manual paste** — the Sheet tile in the actions sheet, saved via `PATCH /api/jobs/{id}`

### Parsing + alignment (`chords.js`)
- `parseChordSheet()` splits the text into sections: `[Section Label]`, chord lines,
  lyric lines, and `Key: value` metadata lines
- A line is a chord line when **every** whitespace-separated token matches `CHORD_TOKEN_RE`;
  it is then paired with the next non-chord line as its lyric
- **Column positions are load-bearing**: chord lines keep their original spacing and lyric
  lines are only `trimEnd()`ed, so a chord sits above the right syllable. Both render
  monospace at the same `--cs-font-size` with `white-space: pre` (the panel scrolls
  horizontally rather than wrapping, which would desync the columns)
- `assignTimestamps()` + `smartMatchLyrics()` match each sheet lyric line to an LRC line by
  word-overlap score (accent-insensitive), monotonically forward, so the sheet can follow
  playback. Lines that re-match the previous LRC line get `time: null` and stay highlighted
  as a continuation of it

### Views (`chords.js`)
- `chordify` — the chord + lyric sheet (default when a sheet exists)
- `spotify` — large centered LRC lyrics, karaoke scroll (fallback when there's no sheet)
- `off` — hidden

Switch via the Lyrics pills in the actions sheet or the `L` key.

---

## Key UI Patterns

### View system (`ui.js`)
Single-page app — views are hidden/shown by toggling `display`. Main views:
- `#library-view` — home/song list
- `#player-view` — active song

`#sheet` (add song), `#settings-panel`, and `#player-actions-sheet` are overlays.

### Player flow
1. User selects song -> `openPlayer(job)` -> calls `GET /api/stems/{id}`
2. `initLyrics()` parses the chord sheet + LRC and auto-selects the default view
3. `applySongMeta()` shows the BPM badge and the action tiles
4. `loadStems()` creates Web Audio nodes for each `.ogg` stem file
5. Each animation frame calls `updateLyricIdx(elapsed)` to advance the highlight

### Actions sheet (MORE)
Volume stepper, tempo stepper, tiles (Sheet, BPM), Lyrics pills. Steppers share
`.step-btn` / `.step-value`; each has one function that owns its whole row
(`updateVolumeUI()`, `updateTempoUI()`).

---

## CSS Conventions (`static/css/app.css`)
- Chord sheet: `.cs-section`, `.cs-chord-line`, `.cs-lyric-line`, `.cs-chord-name`,
  `.cs-section-label`, `.cs-metadata-line`; active section is `.cs-section.cs-active`
- Sheet font size: `--cs-font-size` (1.05rem, 0.9rem under 640px) — drives chord and
  lyric lines together, since unequal sizes break column alignment
- Steppers: `.step-btn` (round +/-), `.step-value` (the number; `.off-normal` green,
  `.muted` red)
- App max-width: **1024px** — fixed panels use `calc(50% - 512px)` for left offset

---

## Known Behaviours / Decisions

- **BPM double-time**: autocorrelation often detects at 2× the real BPM for slow songs. The detector halves the result if the half-tempo correlation scores ≥ 60%. `detect-bpm` still writes `beat_times`, but nothing reads it now.
- **Cifra Club ad string**: the page injects an ad label *inside* the chord `<pre>`, arriving glued to the front of a chord line (`Continúa después del anuncioE   G#m`), which shifts every chord out of column. `strip_cifra_ads()` removes it in es/pt/en on both import and save.
- **Chord/lyric column alignment**: never change the font-size, family, or weight of one of the two lines without the other, and never add padding to `.cs-section.cs-active` — the active highlight is colour-only for exactly this reason.
- **Lyrics transitions**: only `opacity` transitions on Spotify mode. Font-size must change instantly to avoid layout reflow.
- **Screen wake lock**: the Wake Lock API needs a secure context, so it is unavailable over `http://<lan-ip>:8000` on a phone. `wake-lock.js` falls back to a muted looping video. Releases are debounced 1.5s because seek/tempo changes pause-then-play.
- **Stem format**: Demucs outputs `.ogg` files; stems are served with Range support for seek.

---

## What's In Progress / Next Steps
- Chord sheet timing still relies on an LRC to anchor lines; songs with no LRC now fall back to Autoscroll (constant rate) rather than following the song properly
- Wake lock is untested on device (both Mac and phone)
- Sheet font size (`--cs-font-size`) may want a user-facing control rather than a CSS constant
