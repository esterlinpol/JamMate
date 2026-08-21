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

# Start the Demucs worker (separate terminal, venv active)
./worker.sh
```
- App runs at `http://localhost:8000`
- Worker polls `/api/jobs/pending` and processes songs via `worker.py` + `demucs_runner.py`

### Worker configuration (env, not flags)
`--server` and `--device` default to `$JAMMATE_SERVER` and `$JAMMATE_DEVICE`, so the
Mac worker — which points at the home server, not localhost — needs no arguments:
```bash
export JAMMATE_SERVER=http://192.168.1.5:8000
./worker.sh                 # uses that server, device=mps (worker.sh's default)
./worker.sh --device cpu     # flags still override
```
Lyric alignment has its own device and model, `$JAMMATE_ALIGN_DEVICE` (default `cpu`)
and `$JAMMATE_ALIGN_MODEL` (default `small`). It deliberately does **not** follow
`--device`: Demucs wants MPS, Whisper on MPS hits unimplemented sparse ops. Pre-warm
the model once, or the first job stalls for minutes on a silent download:
```bash
./venv/bin/python -c "import stable_whisper; stable_whisper.load_model('small')"
```
`worker.sh` calls bare `python`, so the venv must be active. `--name` (default the
machine hostname) is what the heartbeat is keyed by.
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
| `app/main.py` | FastAPI app, mounts `routes.py` + `sync.py`, serves `Layout.html` at `/` |
| `app/routes.py` | All API endpoints (see section below) |
| `app/sync.py` | Song sync between instances: manifest, `plan()`, pull/push, `run_sync()`, CLI |
| `app/db.py` | SQLite schema, migrations, `init_db()`, default chord seeding |
| `tests/test_sync_plan.py` | Tests for `sync.plan()` — fabricated manifests, no server or audio |
| `worker.py` | Background job loop: polls pending jobs, calls Demucs, aligns lyrics |
| `demucs_runner.py` | Wrapper that runs Demucs and writes stems |
| `sheet_parse.py` | Zero-dep Python port of the chord/lyric line classifier in `chords.js` |
| `lyric_align.py` | Forced lyric alignment via stable-ts; run as a subprocess |
| `tests/test_sheet_parse.py` | Tests for `sheet_parse` — fabricated sheets, no audio |
| `worker.sh` | Shell script to start the worker |

### Frontend — HTML Components (JinjaX)
| File | Purpose |
|---|---|
| `components/Layout.html` | Root shell: loads Tailwind, imports `ui.js`, renders all views |
| `components/Player.html` | Player view: header, lyrics/chord-sheet area, stems, transport, actions sheet |
| `components/Library.html` | Song list / home screen |
| `components/AddSheet.html` | Add song form (upload or YouTube URL) |
| `components/EditSong.html` | Edit title/artist bottom sheet, with a swap button |
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
align_status,      -- NULL|pending|running|done|error — local lyric alignment
align_score,       -- 0..1 confidence of the last alignment (Phase 2 gates on this)
align_text_source, -- lrclib-plain|cifra|manual — which text was aligned
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

### `tombstones` table (deleted songs)
```
id, deleted_at
```
Written by `DELETE /api/jobs/{id}`. Without it, a sync pulls a deleted song back from
any peer that still has it. Never garbage collected — 40 bytes a row, and a device
offline for months still needs to see them.

### `settings` table
```
key, value
-- worker_device       cpu|cuda|mps — PREFERRED worker for new jobs (see routing below)
-- worker_grace_sec    how long a non-preferred worker waits before claiming (default 60)
-- worker_last_seen    newest heartbeat from any worker
-- worker_seen:{name}  "{timestamp}|{device}" per worker, so two don't overwrite each other
-- sync_hub_url        empty ⇒ this instance IS the hub; set ⇒ it is a client of that URL
-- sync_token          shared secret for /api/sync/*; empty ⇒ those endpoints return 503
-- sync_last_run       unix ts of the last sync
-- sync_last_result    JSON counters from the last sync
-- preferred_chord_source  (dead — declared in SettingsPatch, never read)
```
`GET /api/settings` masks `sync_token` as `***`, and `POST` ignores an incoming `***`
so a settings save can't clobber the real token with asterisks.

---

## API Endpoints (`app/routes.py`)

### Jobs
| Method | Path | Notes |
|---|---|---|
| GET | `/api/jobs` | List all songs (partial projection — no `updated_at`) |
| GET | `/api/jobs/pending?device=&worker=` | Worker polls this — **atomically claims** the job (see below) |
| GET | `/api/jobs/pending-align?worker=` | Second, lightweight queue — claims the next song queued for local lyric alignment |
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

### Local lyric alignment
| Method | Path | Notes |
|---|---|---|
| POST | `/api/jobs/{id}/align-lyrics?force=0` | Sets `align_status='pending'`, returns 202. 409 if `chord_source='lrclib'` unless `force=1`; 422 if there's no `chord_sheet` and no plain `chord_data` |

When LRCLIB has no *synced* entry, the song used to fall back to constant-rate
Autoscroll, which drifts against the actual singing. Demucs already produces an
isolated `vocals.ogg` — the ideal input for forced alignment — so JamMate times its
own lyrics instead of depending on a hit in a public database.

- **Alignment, never transcription.** Whisper is given the words and only asked
  *where* they fall. No ASR: a song with no lyrics text is an error, not an
  invitation to guess.
- **Runs in `worker.py`, never in the server.** The server container has no torch
  and no numpy (`Dockerfile:6-12` installs six server packages), so
  `POST /api/jobs/{id}/align-lyrics` only flips a flag — a worker picks the song up
  off `/api/jobs/pending-align`.
- **Text source, in preference order:** LRCLIB plain lyrics → Cifra sheet lyric
  lines → manual paste. Plain lyrics win because *the sheet is not what's sung*:
  repeats collapse to `(x2)`, the chorus is written once, `-CHORUS-` markers parse
  as lyrics. Text that skips a repeated chorus drifts from that point on — the
  biggest accuracy risk in this path, and why `align_score` is recorded at all.
- **A real `lrclib` result is never clobbered.** Alignment is skipped when
  `chord_source='lrclib'` unless explicitly forced, and it also fires on
  `lrclib-plain`, not only on total LRCLIB failure.
- **Low confidence is kept and used.** Even a weak alignment beats constant-rate
  autoscroll; the score gates Phase 2 submission, not local use. The SYNC tile
  shows it (`✓ 0.82`) so a weak result is visible rather than silently trusted.
- **`chord_source='aligned'` is just an LRC.** Same format, so `parseLRC`,
  `assignTimestamps`, `smartMatchLyrics` and `needsAutoscroll()` all work unchanged
  — the frontend change is one `||` in `initLyrics()`. No alignment logic in the browser.
- **A separate queue, because source audio isn't retained.** `data/uploads` is
  empty for YouTube songs, so re-queueing a done song as `status='pending'` would
  re-download and re-run Demucs — minutes of work to fix lyrics. The align queue
  only needs `vocals.ogg`, which is already on the server. Same compare-and-swap as
  `/api/jobs/pending`, so two workers can't align one song twice.
- **`align_status` is deliberately not folded into `jobs.status`** — the library card
  renders off that ([ui.js](../static/js/ui.js)) and the song must stay playable
  while its lyrics are being timed.
- **The worker's own LRCLIB fetch was deleted.** It was one-shot, hit only the strict
  `/api/get`, looked at `data[0]` alone, and swallowed every exception into "no
  lyrics". It now calls `POST /api/jobs/{id}/fetch-lyrics` and inherits the server's
  ladder — and, critically, the server's distinction between a network failure (502)
  and a genuine miss (404), which is exactly what decides whether to align.
- `duration_sec` is PATCHed **before** that call: LRCLIB's strict match needs it, and
  writing it only in the final patch silently downgraded every song to fuzzy search.

`sheet_parse.py` is a faithful port of the classifier in `chords.js` — not an
approximation. It has to select exactly the lines `assignTimestamps()` will try to
time, or the generated LRC times lines the sheet never renders. `_CHORD_NAME_RE` in
`routes.py` is unanchored and only ranks whole `<pre>` blocks; it must **not** be
reused as a line classifier. Parity is verified against all 35 stored sheets.

**`clean_for_align()` is deliberately narrower than `sheet_lyric_lines()`**, and that
split is load-bearing: what gets *rendered* and what gets *aligned* are different
questions. Whisper places every line it is given (`original_split=True`), so a line
that isn't sung doesn't get skipped — it gets placed anyway, stealing time from a real
neighbouring line. So the aligner additionally drops:

- **Guitar tab rows** (`E|-----------|`) — 56 of them across the 35 sheets. The parser
  classifies them as lyrics because they aren't chord *tokens*.
- **Hyphen/comma chord groups** (`A# Dm-Gm-Cm-F-A#`). `is_chord_line()` tests one
  whitespace token at a time, so a whole chord row hides in the lyric branch.
- **Section labels** (`Coro`, `Verso2`, `Punteo del puente:`) — `is_metadata_line()`
  misses them because it requires `word:` followed by *whitespace*.

Filtering here needs **no change in `chords.js`**, which is exactly why it lives here
and not in the shared classifier. The label rule is kept narrow on purpose — a false
positive silently deletes a real lyric line — so `solo` and `final` are absent from
`_SECTION_WORDS` (both are ordinary Spanish words) and a bare label must be a single
token, optionally followed by a number. Verified against the 31 songs with known-good
LRCLIB lyrics: of the 93 lines dropped, none appear in the actual sung lyrics.

### Job claiming & worker routing (`routes.py:get_pending`)
`/api/jobs/pending` used to be a bare `SELECT ... WHERE status='pending' LIMIT 1` with no
status flip, so two workers sharing one server both grabbed the same job. It now:

1. Picks a candidate, then does a **compare-and-swap** `UPDATE ... WHERE id=? AND status=?`.
   Only one caller can win; the loser gets `{"job": null}` and polls again. Portable —
   no `RETURNING`, so the SQLite in the server container doesn't matter.
2. Applies `worker_device` as a **preference, not a gate**: a worker whose `--device`
   matches claims immediately; any other waits until the job is older than
   `worker_grace_sec`. So the Mac takes new songs while it's around and the server's CPU
   worker covers when it isn't. **Nothing can starve** — a wrong setting costs 60s, not a
   stuck queue. An unset preference, or a worker that sends no `device`, claims at once.
3. Falls back to **reclaiming a stale job**: `processing` with `updated_at` older than
   `_STALE_CLAIM_SEC` (30 min) means that worker died. Any worker may take it, with no
   preference or grace applied, because the job is already late. Every `_patch` from the
   worker refreshes `updated_at`, which is what makes it a per-job heartbeat.

### Sync (`app/sync.py`)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/sync/manifest` | Token-gated. Every song's id/status/`updated_at` + `{stem: size}`, plus tombstones and the column list |
| PUT | `/api/sync/jobs/{id}` | Token-gated. Whole-row upsert, writing `created_at`/`updated_at` **verbatim**; clears any tombstone for that id |
| POST | `/api/sync/run` | Local control plane (not token-gated) — starts a background thread |
| GET | `/api/sync/status` | Live counters, phase, warnings, errors, `is_hub` |

Plus `python -m app.sync [--hub URL] [--direction both|pull|push]` for cron/manual runs.

- **Role is config, not a build**: `sync_hub_url` empty ⇒ hub (serves only, never
  initiates); set ⇒ client of that address. Every instance runs the same code, so a
  mobile app later is just another client of these calls.
- **`updated_at` is the sync clock.** `patch_job` restamps it locally on every edit, which
  is correct; the sync upsert copies it verbatim so both sides agree which copy is newer.
  `SKEW = 1.0`s absorbs JSON float round-tripping — without it the two sides ping-pong
  forever. That is what `tests/test_sync_plan.py`'s idempotency test guards.
- **Sizes, not checksums.** A stem is written once, by one worker, into a globally unique
  `{job_id}` dir, so two sides can never hold different bytes under the same name. Size
  answers "present and complete", and hashing 154 MB per manifest would not be free.
- **Only `done` songs carry stems.** A `pending` song added on a client is pushed up
  metadata-only (`push_pending`) so whichever worker is up separates it; the stems come
  back on a later run. Guarded on the hub not knowing the id in *any* state, so it can't
  double-submit. Don't point a worker at an instance that has `sync_hub_url` set.
- **Half-copied songs are structurally unplayable**: the row is held at `status='syncing'`
  while audio is in flight, `GET /api/stems/{id}` 400s unless `done`, and `renderCard`
  only makes `done` cards clickable. Stems stage through `{name}.part` — invisible to
  `get_stems`, which filters on suffix — then `os.replace()`.
- **Resume needs no journal.** A `syncing` row isn't `done`, so it looks absent and
  re-enters the pull; stems already on disk at the right size are skipped. The plan is
  recomputed from state every run, so there's no cursor to corrupt.
- **`plan()` is pure** — two dicts in, actions out. Every real bug (ping-pong, tombstone
  resurrection, direction inversion, stem size) is testable with no server or audio.
- **Schema drift is reported, not silent.** The upsert whitelist comes from
  `PRAGMA table_info(jobs)`, not a hardcoded list, because this checkout routinely runs a
  newer schema than the deployed hub. Differing columns produce a warning instead of
  quietly dropped fields.
- **Auth fails closed**: no `sync_token` (or `$JAMMATE_SYNC_TOKEN`) ⇒ `/api/sync/*` returns
  503, so deploying this code opens nothing. `POST /api/jobs/{id}/stems/{name}` stays
  unauthenticated because `worker.py` uses it — same posture as before.
- Not synced: `data/uploads` (source audio isn't retained anyway), `settings`
  (per-machine), `chords` (per-machine uuids).

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
  monospace at the same `--cs-font-size` with `white-space: pre`
- **Paired wrapping** (`wrapPair()` in `chords.js`) keeps long lines on screen. CSS
  wrapping can't be used — `pre-wrap` breaks the chord line and the lyric line at
  different widths and slides every chord off its syllable. Instead both halves of a
  pair are cut at the *same* column, chosen by `safeBreak()` so it lands neither inside
  a chord token nor inside a word; only the indent the two continuations share is
  trimmed. Segments render as extra `<pre>`/`<p>` pairs **inside the same
  `.cs-section`** wrapper, so `assignTimestamps()` indices and the `cs-${idx}` scroll
  anchors stay one-per-section
  - The budget comes from `measureChordSheetCols()`, which measures real elements
    (glyph advance from an out-of-flow span, width from an in-flow `<pre>`) rather than
    assuming a glyph ratio — so it survives `--cs-font-size` changes and whatever
    monospace the device substitutes. Returns 0 before layout, which means "don't wrap"
  - The wrap is baked into the DOM, so `resize`/`orientationchange` re-render (debounced
    150ms, skipped when the column count is unchanged so URL-bar height changes are free)
  - Splitting a word is preferred over splitting a chord name: a halved chord is
    unreadable, a halved word is merely ugly
  - `overflow-x: auto` on the panel is now only a safety net (chord token wider than the
    panel, or a pre-layout measurement)
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

`#sheet` (add song), `#edit-sheet` (edit title/artist), `#settings-panel`, and
`#player-actions-sheet` are overlays.

### Editing a song's title/artist
A YouTube title arrives as one string and `_parse_yt_title` has to guess which half is
the artist — it guesses wrong often enough to need a fix-up. Not cosmetic: title and
artist are what the **LRCLIB and Cifra Club lookups search with**, so a wrong one costs
the song its lyrics *and* its chord sheet.

- Reached from the **pencil on each library card**, not from the player: a card is only
  clickable once it's `done`, so a `pending` or `error` song could never be corrected
  from the player — and that's precisely when fixing the title still changes the outcome.
- `#edit-sheet` reuses `#sheet`'s CSS geometry (shared selector list in `app.css`) so the
  1024px max-width offset lives in exactly one place.
- The **Swap** button exists for the specific failure above. Saving also updates an open
  player's header when it's the same song.
- A blank artist **clears** the field; a blank title is rejected. That follows
  `patch_job`, where `None` means "don't touch" but `""` is written — so there's no way
  to blank a title by accident and leave the song unsearchable.
- Renaming touches only `title`/`artist`; `chord_data`, `chord_sheet` and the align
  columns are left alone. After a fix, re-run **Lyrics** / **Sheet** / **Sync** to
  benefit from the corrected search terms.

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
- **Path validation on audio routes**: `job_id` and stem filenames arrive from the URL and
  get joined onto a filesystem path, so `_safe_id()` / `_safe_stem_name()` guard
  `get_stem`, `upload_stem`, `upload_source`, `delete_job` and the sync PUT. Without them
  `POST /api/jobs/x/stems/../../app/foo.py` was an unauthenticated arbitrary file write.
  Note `.part` names are deliberately rejected from the network — they are internal only.
- **Both `detect-bpm` and `fetch-cifra` are `async def` doing blocking work in the event
  loop**, so they stall stem streaming for whoever is playing. Pre-existing and out of
  scope, noted because `align-lyrics` must not repeat it — it only flips a flag, and
  `fetch-lyrics` is deliberately declared `def` so FastAPI threadpools it.
- **`patch_job` cannot clear a field or set timestamps**: `None` means "don't touch", and
  `updated_at` is always restamped locally. That's right for UI edits and wrong for sync,
  which is why `PUT /api/sync/jobs/{id}` exists as a separate whole-row upsert rather than
  `JobPatch` being widened — `worker.py:_patch()` and four `ui.js` callers depend on the
  current semantics.

---

## What's In Progress / Next Steps
- Sync UI lives only in the Settings sheet (hub URL, token, Sync now). There is no
  per-song "not downloaded" state — a client pulls every `done` song in full
- Optional and not done: `JAMMATE_DATA_DIR` so two instances can share one checkout
  without symlinking `components/` and `static/` into a second working directory; the
  sync token on `worker.py`'s stem upload; surfacing `worker_seen:{name}` rows in Settings
  so you can see *which* worker is alive rather than just "a worker is"
- Chord sheet timing still relies on an LRC to anchor lines, but that LRC no longer has
  to come from LRCLIB — the worker generates one locally from the vocals stem (see Local
  lyric alignment). Autoscroll is now the fallback only when there is no lyric *text* at
  all to align, or the alignment failed
- Alignment accuracy is unmeasured. All 35 songs bar three already have real LRCLIB
  synced lyrics, which is free ground truth: align each from the *sheet* text, diff
  against the known-good LRC, and pick the Phase 2 score threshold from data rather
  than guessing. Worth doing before trusting a low score
- Phase 2 (submitting good alignments back to LRCLIB) needs `albumName`, which has no
  column — expect a second migration and a manual backfill
- Wake lock is untested on device (both Mac and phone)
- Sheet font size (`--cs-font-size`) may want a user-facing control rather than a CSS constant
