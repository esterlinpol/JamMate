# JamMate — Project Reference for Claude

## What This Is
JamMate is a local web app for musicians. You upload or import a song (YouTube or audio file), it splits it into stems (vocals, guitar, bass, drums, piano, other) using Demucs, and lets you:
- Play/mute/solo individual stems with a volume slider
- Display lyrics (LRC format or Chordify-style chord+lyric view)
- Edit and sync a chord chart to the beat grid
- Detect BPM and align chord changes to the beat

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
| `components/Player.html` | Player view: header, beat strip, diagram row, edit panel, stems, transport |
| `components/Library.html` | Song list / home screen |
| `components/AddSheet.html` | Add song form (upload or YouTube URL) |
| `components/ChordEditor.html` | Modal for editing a chord definition (fretboard SVG) |
| `components/ChordLibrary.html` | Chord library view (browse/add/edit chord shapes) |
| `components/Settings.html` | Settings panel (worker device, etc.) |

### Frontend — JavaScript (`static/js/`)
| File | Purpose |
|---|---|
| `ui.js` | Main controller: wires all DOM events, manages view transitions, calls all other modules |
| `player.js` | Web Audio API multi-stem player: play/pause/seek/volume/mute/solo/rate |
| `chord-play.js` | Beat strip rendering, chord timeline, BPM sync, edit mode, bulk import |
| `chord-lib.js` | Chord library API calls + `renderChordSVG()` |
| `chords.js` | Lyrics display: LRC parsing, Chordify-style view, Spotify-style scroll |

### Frontend — CSS
| File | Purpose |
|---|---|
| `static/css/app.css` | All custom styles (Tailwind handles utilities; this has beat-box, chord diagrams, etc.) |

---

## Database Schema (`data/songs.db`)

### `jobs` table (one row per song)
```
id, title, artist, filename, source_type (upload|youtube), source_url,
status (pending|processing|done|error), model, shifts,
stem_base, chord_data, chord_source, chord_source_url, capo,
duration_sec, progress, progress_phase, error_msg,
created_at, updated_at,
song_chord_data,   -- LRC-format chord timeline: [MM:SS.ss]ChordName\n...
bpm,               -- detected float
beat_times,        -- JSON array of beat timestamps (seconds, uniform spacing)
beat_offset,       -- float: seconds shift applied to all beat_times for phase alignment
bar_offset         -- int 0-3: which beat index is beat 1 of bar 1 (bar grouping shift)
```

### `chords` table (reusable chord shape library)
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

### Chords Library
| Method | Path | Notes |
|---|---|---|
| GET | `/api/chords` | All chord shapes |
| POST | `/api/chords` | Create chord |
| GET | `/api/chords/{id}` | Single chord |
| PUT | `/api/chords/{id}` | Update chord |
| DELETE | `/api/chords/{id}` | Delete chord |

---

## Chord System

### Chord timeline format (`song_chord_data`)
LRC-style text stored in DB, one chord per line:
```
[00:02.46]Em7
[00:05.25]D
[00:08.04]C
```
Parsed in `chord-play.js:parseLrcChords()`. Serialized in `serializeChordTimeline()`.

### Beat strip (`chord-play.js`)
- `beatTimes[]` = raw DB times + `beatOffset`
- Each beat renders as a `.beat-box` div (52px wide)
- Beat 1 of each bar gets class `bar-start` (green left border)
- Bar grouping: `posInBar = (i - barOffset + 4000) % 4`
- `barOffset` (0–3): which beat index is bar 1 beat 1 — user-controlled via buttons in edit panel
- Active beat scrolls to 40% from left

### Edit mode controls (Edit panel header)
- **Bar 1 [1][2][3][4]**: sets `barOffset` — shifts where bar lines appear
- **⏮ ◀ +0.000s ▶ ⏭**: `nudgeBeatOffset(±0.025s)` / `nudgeBeatOffsetByBeat(±1)` — shifts entire beat grid phase, saved to DB as `beat_offset`
- **Import…**: opens bulk import modal
- **Clear all**: wipes chord timeline

### Bulk import format
```
. . . | Em7 . . . | D . . . | . C . Em7 | Am7 . . .
```
- One token per beat
- `.` = hold previous chord
- `-` = no chord (silence)
- `|` = **snap to next bar boundary** (skips leftover beats in current bar — does NOT just separate bars visually)
- Chord name = new chord starts here
- Multi-line input is treated as continuous

### Chord SVG renderer (`chord-lib.js:renderChordSVG`)
Sizes: `small` (64×60), `medium` (90×80), `large` (140×120), `xl` (190×160)

---

## Key UI Patterns

### View system (`ui.js`)
Single-page app — views are hidden/shown by toggling `display`. Main views:
- `#library-view` — home/song list
- `#player-view` — active song
- `#chord-lib-view` — chord library
- `#settings-view` — settings

### Player flow
1. User selects song → `openPlayer(job)` → calls `GET /api/stems/{id}`
2. `loadStems()` creates Web Audio nodes for each `.ogg` stem file
3. `initChordPlay()` loads beat grid + chord timeline
4. `initLyrics()` loads lyrics/chord view
5. Each animation frame calls `tickChordPlay(currentTimeSec)` to sync beat highlight

### Lyrics modes (cycled by LYRICS button)
- `off` — hidden
- `chordify` — chord+lyric rows (from `chord_data`)
- `spotify` — large centered lyrics, karaoke-style scroll

---

## CSS Conventions (`static/css/app.css`)
- Beat boxes: `.beat-box` (inline-flex column, 52×64px)
- Chord name inside box: `.beat-chord` (uppercase, bold)
- Beat number: `.beat-num` (tiny, below chord name, opacity 0.5)
- Bar start: `.beat-box.bar-start` (green left border)
- Active beat: `.beat-box.active` (dark green bg + bright border)
- Past beats: `opacity: 0.35` / Future: `opacity: 0.75`
- Bar offset selector: `.bar-offset-btn` + `.bar-offset-btn.active`
- App max-width: **1024px** — fixed panels use `calc(50% - 512px)` for left offset

---

## Known Behaviours / Decisions

- **BPM double-time**: autocorrelation often detects at 2× the real BPM for slow songs. The detector now halves the result if the half-tempo correlation scores ≥ 60%. Re-detect button is always visible (shows current BPM as label).
- **Beat uniformity**: beats are generated as `phase + n * beat_interval` in float-seconds, NOT by stepping integer frames — avoids cumulative drift.
- **Bar offset vs beat offset**: `bar_offset` (int, 0–3) controls the *visual grouping* of beats into bars. `beat_offset` (float, seconds) shifts the *timing* of all beats. They're independent.
- **`|` in import snaps, not separates**: the pipe character advances the beat cursor to the next bar boundary. It doesn't just ignore whitespace — it may skip 1–3 beats depending on current position.
- **Lyrics transitions**: only `opacity` transitions on Spotify mode. Font-size must change instantly to avoid layout reflow.
- **Stem format**: Demucs outputs `.ogg` files; stems are served with Range support for seek.

---

## What's In Progress / Next Steps
- Chord import alignment: some songs need `. C` instead of `| C` to land C on beat 2 of a bar rather than beat 1 (depends on the song's pickup structure)
- Working on "Suelta Mi Mano" by Sin Bandera chord chart — import format being refined
- Beat phase alignment workflow: detect BPM → set Bar 1 offset → use ⏭/⏮ to shift by full beats → fine-tune with ◀/▶
