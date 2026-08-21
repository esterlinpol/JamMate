# Local Lyric Alignment — Phase 1

> Status: **implemented**. See CLAUDE.md for the resulting shape of the code.
> Phase 2 (submitting results back to LRCLIB) is a separate document.
>
> Deltas from the plan as written, all deliberate:
> - `lyric_align.py` gained `--original`, because the aligner has to *see* the cleaned
>   text and *emit* the original. One `--text` file could not carry both.
> - The worker now PATCHes `duration_sec` before asking for lyrics. LRCLIB's strict
>   `/api/get` match needs it, and it used to be written only in the final patch — so
>   every song was silently downgraded to the fuzzy `/api/search` endpoint.
> - `--align-device` is its own flag rather than following `--device`: Demucs wants MPS,
>   Whisper can't have it.
> - The library is 35 songs, not the 7 the plan assumed; the parser-parity check was
>   run against all of them (35/35 byte-identical to the browser).

## Context

JamMate's synced lyrics come only from LRCLIB. When LRCLIB has no synced entry, the song
falls back to constant-rate Autoscroll, which drifts against the actual singing. Demucs
already produces an isolated `vocals.ogg`, which is the ideal input for forced alignment —
so JamMate can time its own lyrics locally instead of depending on a hit in a public DB.

**Phase 1 (this document):** detect the gap and generate the timestamps locally.
**Phase 2 (later):** submit good results back to LRCLIB's publish API.

Phase 1 deliberately writes the provenance and quality columns Phase 2 will need, so
Phase 2 is additive rather than a migration.

### Decisions taken

| Question | Answer |
|---|---|
| Where it runs | `worker.py`, never the FastAPI server |
| Engine | `stable-ts` (`align()` with `original_split=True`) |
| Text source | LRCLIB plain lyrics → Cifra sheet lyric lines → manual paste. **No ASR transcription.** |
| Trigger | Also fires on `lrclib-plain`, not only on total LRCLIB failure |
| Low-confidence results | Keep and use locally; the score gates Phase 2 submission only |
| `album` column | Deferred to Phase 2 |

---

## Constraints discovered during exploration

1. **The server container has no torch and no numpy.** `Dockerfile:6-12` installs six
   server packages only. Everything the server does here must stay stdlib
   (`urllib.request`, `json`, `subprocess`). New deps go under `# Worker` in
   `requirements.txt`.
2. **Source audio is not retained.** `data/uploads/` is empty; all 7 jobs are
   `source_type='youtube'`. Re-queueing with `status='pending'` would re-download and
   re-run Demucs — minutes of work to fix lyrics. The manual re-run therefore needs its
   own lightweight queue.
3. **The worker's LRCLIB fetch is much weaker than the server's.** `_fetch_lrclib`
   ([worker.py:222](../worker.py#L222)) is one-shot, hits only `/api/get` (strict exact
   match), inspects only `data[0]`, and swallows every exception into "no lyrics".
   The server's `_lrclib_lookup` ([routes.py:434](../app/routes.py#L434)) already does
   2 endpoints × 3 attempts with backoff and — critically — **distinguishes network
   failure (raises → 502) from a genuine miss (returns None → 404)**. That distinction
   is exactly what the fallback trigger needs, and it already exists.
4. **`chord_source` has only two literal values** repo-wide and one real consumer,
   `initLyrics()` at [chords.js:34](../static/js/chords.js#L34). A new value is contained.
5. **No Python chord/lyric line classifier exists.** `_CHORD_NAME_RE`
   ([routes.py:553](../app/routes.py#L553)) is unanchored and only ranks whole `<pre>`
   blocks — it must **not** be reused as a line classifier. The logic lives only in
   [chords.js:167-237](../static/js/chords.js#L167-L237) and has to be ported.
6. Adding a DB column means three places: the `CREATE TABLE` block, the migration tuple
   list at [db.py:86-95](../app/db.py#L86-L95), and `JobPatch` at
   [routes.py:75](../app/routes.py#L75).
7. `/api/jobs/pending` has **no claim lock** — two workers would grab the same job. The
   new queue inherits this; setting `align_status='running'` on pickup narrows it.

---

## Design

### New: `sheet_parse.py` (repo root, zero dependencies)

A faithful Python port of the line classification in `chords.js`, importable by both the
worker and (later) the server.

- `CHORD_TOKEN_RE`, `SECTION_LINE_RE`, `is_chord_line()`, `is_metadata_line()` — ported
  verbatim from [chords.js:6](../static/js/chords.js#L6) and
  [chords.js:167-178](../static/js/chords.js#L167-L178).
- `sheet_lyric_lines(text) -> list[str]` — reproduces `parseChordSheet()` and returns
  exactly the set `assignTimestamps()` selects: sections where
  `lyricLine && !sectionLabel && !isMetadata`. Preserve the five-branch precedence order
  and the `i += 2` chord/lyric pairing consumption, or the output silently diverges.
- `clean_for_align(line) -> str` — strips what the singer doesn't sing: held-note padding
  (`([a-z0-9])_+\1` → `\1`, same rule as `wordOverlapScore` at
  [chords.js:319](../static/js/chords.js#L319)), `(x2)` / `(2x)` / `(bis)` markers, and
  bare dash markers like `-CHORUS-`. Returns `""` for a line that is pure marker.

Alignment works on `[(original, cleaned)]` pairs with empty-cleaned entries dropped, and
the emitted LRC carries the **original** text — so `smartMatchLyrics()` re-matches it
against the sheet at near-identical scores.

### New: `lyric_align.py` (repo root, run as a subprocess)

Mirrors the `demucs_runner.py` pattern ([worker.py:252](../worker.py#L252)): the worker
shells out with `sys.executable`, so a torch crash or OOM cannot kill the poll loop.

```
python lyric_align.py --audio vocals.ogg --text lines.txt \
                      --lang auto --model small --device cpu --out result.json
```

Emits `{"lrc": "...", "score": 0.0-1.0, "language": "es", "lines": N, "aligned": N}`.

- `--lang auto` runs Whisper's language detection on the first 30 s of the vocals stem.
  Nothing in the schema stores a language and it must not be hardcoded — 6 of the current
  songs are Spanish, 1 is English.
- `model.align(audio, text, language=..., original_split=True, failure_threshold=0.5)` —
  `original_split=True` is what guarantees one result segment per input line.
- `score` = mean word probability, discounted by the fraction of zero-duration words.
- LRC is emitted as `[MM:SS.hh] {text}` — **two** fraction digits, which is what
  `parseLRC` ([chords.js:151](../static/js/chords.js#L151)) requires and what the stored
  `chord_data` already looks like.
- Set `PYTORCH_ENABLE_MPS_FALLBACK=1`; default `--device cpu` (Whisper on MPS hits
  unimplemented sparse ops). A 4-minute vocals stem on `small` is roughly a minute on CPU.

### `worker.py`

**1. Replace `_fetch_lrclib` with `_fetch_lyrics(server, job_id)`** that delegates to
`POST /api/jobs/{id}/fetch-lyrics`, exactly mirroring `_fetch_cifra_sheet`
([worker.py:49-75](../worker.py#L49-L75)). Add `_LYRICS_ATTEMPTS = 2`,
`_LYRICS_BACKOFF = 1.5`.

| Response | Meaning | Action |
|---|---|---|
| 200, `synced: true` | `lrclib` | Done. **Never align** — don't clobber real synced lyrics |
| 200, `synced: false` | `lrclib-plain` | Align, using that text |
| 404 | genuine miss | Don't retry — align, using the Cifra sheet |
| 422 | no title | Don't retry — align, using the Cifra sheet |
| 502 / exception | network | Retry `_LYRICS_ATTEMPTS`, then fall through to align |

This is the "fails twice — network, then not-found" fallback. The server's ladder already
absorbs transient failures (3 attempts × 2 endpoints); the worker adds one outer retry and
then gives up. Beyond the fallback, the worker inherits the server's better lookup for
free and a duplicated, weaker implementation is deleted.

The endpoint writes `chord_data`/`chord_source` itself, so the worker no longer carries
them through to the final `done_patch` ([worker.py:389-391](../worker.py#L389-L391)).

**2. New Step 6, after Cifra and before BPM.** Order is load-bearing: the Cifra sheet
supplies the alignment text, so it must already be fetched. `vocals.ogg` is already local
in `tmp_path` from Step 3 ([worker.py:352](../worker.py#L352)) — the same way `drums.ogg`
is reused for BPM at [worker.py:374](../worker.py#L374). No download needed on this path.

New progress ladder (currently 90/92/95/100):

| Step | progress | phase |
|---|---|---|
| 4 | 88 | `Fetching lyrics…` |
| 5 | 90 | `Fetching chords…` |
| 6 | 92 | `Aligning lyrics…` ← **new** |
| 7 | 97 | `Detecting tempo…` |
| 8 | 100 | `Done` |

`_align_lyrics()` is **non-fatal**, like `_detect_bpm` and `_fetch_cifra_sheet`: any
exception logs, PATCHes `align_status='error'`, and lets the job complete.

**3. Second poll branch** for the manual re-run queue: after `/api/jobs/pending` returns
nothing, check `/api/jobs/pending-align`. On pickup, download
`/api/audio/{id}/vocals.ogg` to a tempdir, read the job row for text, align, PATCH, done.

### `app/db.py`

Add to the `CREATE TABLE` block **and** the migration tuple list at
[db.py:86-95](../app/db.py#L86-L95):

- `align_status TEXT` — `NULL | pending | running | done | error`
- `align_score REAL` — 0..1; Phase 2 gates submission on this
- `align_text_source TEXT` — `lrclib-plain | cifra | manual`; Phase 2 needs the provenance

Deliberately **not** overloading `jobs.status` — the library card renders off it
([ui.js:73-79](../static/js/ui.js#L73-L79)) and the song must stay playable while aligning.

### `app/routes.py` (stdlib only — the server does zero compute here)

- `JobPatch` ([routes.py:75](../app/routes.py#L75)) += the three new fields.
- `GET /api/jobs/pending-align` — mirrors `/api/jobs/pending`;
  `WHERE status='done' AND align_status='pending' ORDER BY updated_at ASC LIMIT 1`.
- `POST /api/jobs/{id}/align-lyrics` — sets `align_status='pending'`, returns 202.
  409 if `chord_source='lrclib'` unless `?force=1`; 422 if there is neither a
  `chord_sheet` nor plain `chord_data` to align against.
- `/api/stems/{job_id}` ([routes.py:188](../app/routes.py#L188)) += the three new fields.
- [routes.py:507](../app/routes.py#L507): `"synced": chord_source in ("lrclib", "aligned")`.

### `static/js/chords.js`

One branch. At [chords.js:35](../static/js/chords.js#L35):

```js
if ((chordSource === 'lrclib' || chordSource === 'aligned') && chordData) {
```

Everything downstream already works: `parseLRC` accepts the emitted format,
`assignTimestamps` + `smartMatchLyrics` time the sheet, and `needsAutoscroll()`
([chords.js:77](../static/js/chords.js#L77)) turns Autoscroll off by itself once sections
carry a `time`. **No new alignment logic on the frontend.**

### `components/Player.html` + `static/js/ui.js`

- A fourth **SYNC** tile in `#actions-tile-section`
  ([Player.html:129](../components/Player.html#L129)), alongside Sheet / Lyrics / BPM.
  Kept separate from the Lyrics tile because they mean different things: Lyrics =
  "ask LRCLIB", Sync = "compute it here".
- Handler modelled on `fetchLyrics` ([ui.js:265-291](../static/js/ui.js#L265-L291)): POST,
  then poll `GET /api/jobs/{id}` every 3 s for `align_status`, showing `progress_phase`
  in the label. Reuse the `_currentPlayerJobId` staleness guard. The player view has no
  poll loop today ([ui.js:619](../static/js/ui.js#L619) only refreshes the library), so
  this poller is scoped to the tile and cleared on completion or song change.
- On success, re-fetch `/api/stems/{id}` then `resetLyrics()` + `initLyrics()`, exactly as
  [ui.js:276-279](../static/js/ui.js#L276-L279).
- Show `align_score` on the tile (e.g. `✓ 0.82`) so a weak alignment is visible rather
  than silently trusted.
- **No new manual-paste UI.** Pasting into the existing Sheet modal already writes
  `chord_sheet`, which the aligner reads — manual paste is covered for free.

### `requirements.txt`

`stable-ts>=2.19.0` under `# Worker`. Dockerfile untouched. One-time model pre-warm
documented in the run instructions:

```bash
./venv/bin/python -c "import stable_whisper; stable_whisper.load_model('small')"
```

so the first job doesn't stall for minutes on a silent download.

---

## What this plan adds beyond the original framing

1. **Cifra must be fetched before alignment** — it supplies the text. Steps reorder.
2. **Language is not in the schema** and can't be hardcoded (6 ES + 1 EN). Detect it.
3. **The re-run path can't reuse the main queue** — source audio isn't retained, so a
   naive `status='pending'` re-queue means a full Demucs re-run.
4. **The Cifra sheet is not what's sung.** Repeats collapsed to `(x2)`, chorus written
   once, `-CHORUS-` markers that the parser classifies as *lyrics*, solo sections. Text
   that skips a repeated chorus drifts from that point on. This is the biggest accuracy
   risk; it's why LRCLIB plain text is preferred over the sheet, why `clean_for_align()`
   exists, and why `align_score` is recorded.
5. **Never clobber a good `lrclib` result** — alignment is skipped when `chord_source`
   is already `'lrclib'`, unless explicitly forced.
6. **Phase 2 needs `albumName`, which has no column.** Deferred by choice, so expect a
   second migration and a manual backfill then.
7. Both `detect-bpm` ([routes.py:345](../app/routes.py#L345)) and `fetch-cifra`
   ([routes.py:676](../app/routes.py#L676)) are `async def` doing blocking work in the
   event loop — they stall stem streaming. Pre-existing, out of scope, noted because the
   new endpoints must not repeat it (they won't; they only flip a flag).

---

## Verification

1. **Parser parity.** Run `sheet_parse.sheet_lyric_lines()` over all 7 stored
   `chord_sheet` values and compare to what the browser already logs — `assignTimestamps`
   prints every sheet line under `console.group('[JamMate] Chord sheet → LRC matching')`
   ([chords.js:277](../static/js/chords.js#L277)). Counts and text must match exactly.
2. **Accuracy benchmark against ground truth.** All 7 songs already have real LRCLIB
   synced lyrics. Run the aligner on each using the *sheet* text and diff the generated
   timestamps against the known-good LRC. Report mean and median absolute error per line,
   and correlate with `align_score` to pick the Phase 2 threshold from data rather than
   guessing. This is free and must happen before trusting the output on anything.
3. **End-to-end.** On one song, `PATCH chord_data=null, chord_source=null`, tap SYNC,
   confirm `align_status` transitions, then play and watch the sheet highlight in time
   and Autoscroll stay off.
4. **Fallback paths.** Force a 502 by pointing `_lrclib_get` at an unreachable host and
   confirm the worker retries twice then aligns; add a job with a nonsense title to force
   a 404 miss and confirm it aligns without retrying.
5. **Regression.** Confirm a song with real `lrclib` synced lyrics is left completely
   untouched by a full worker run.

---

## Phase 2 preview (not in scope here)

LRCLIB submission needs no account — just a proof-of-work token:

1. `POST https://lrclib.net/api/request-challenge` → `{prefix, target}`
2. Find a nonce where `sha256(f"{prefix}{nonce}").digest() < bytes.fromhex(target)`
3. `POST https://lrclib.net/api/publish` with header `X-Publish-Token: {prefix}:{nonce}`
   and body `{trackName, artistName, albumName, duration, plainLyrics, syncedLyrics}`.
   HTTP 201 means accepted.

The [`lrcup`](https://github.com/iiPythonx/lrcup) library wraps all of this. Two gotchas:
`duration` must be the integer seconds LRCLIB matches on (±2 s) or nobody's lookup finds
the upload; and there is no moderation, so `align_score` plus a human listen must gate
every submission.
