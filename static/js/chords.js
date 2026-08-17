'use strict';

const LYRIC_OFFSET_SEC = 0.5;

// Regex matching a single chord token: e.g. Em, D, C, Am7, B7, Gmaj7, F#m, Bb, G/B
const CHORD_TOKEN_RE = /^[A-G][#b]?(?:maj|min|sus|aug|dim|add|M|m)?[0-9]*(?:\/[A-G][#b]?(?:maj|min|sus|aug|dim|add|M|m)?[0-9]*)?$/;

const $ = id => document.getElementById(id);

let lyricsMode       = null;
let parsedLyrics     = null;
let plainLyricsText  = null;
let parsedChordSheet = null; // [{chordLine, lyricLine, time}]
let currentLyricIdx  = -1;
let hasLyrics        = false;
let _seekFn          = () => {};

export function setSeekFn(fn) { _seekFn = fn; }

export function resetLyrics() {
  lyricsMode       = null;
  parsedLyrics     = null;
  plainLyricsText  = null;
  parsedChordSheet = null;
  currentLyricIdx  = -1;
  hasLyrics        = false;
  resetAutoscroll();
  $('lyrics-toggle-btn').classList.add('hidden');
  $('lyrics-chordify-panel').classList.add('hidden');
  $('lyrics-spotify-panel').classList.add('hidden');
  $('lyrics-mode-label').textContent = 'OFF';
}

export function initLyrics(chordData, chordSource, chordSheet) {
  if (chordSource === 'lrclib' && chordData) {
    parsedLyrics = parseLRC(chordData);
    hasLyrics    = parsedLyrics.length > 0;
  } else if (chordSource === 'lrclib-plain' && chordData) {
    plainLyricsText = chordData;
    hasLyrics       = true;
  }
  if (chordSheet) {
    const sections = parseChordSheet(chordSheet);
    parsedChordSheet = assignTimestamps(sections);
    if (parsedChordSheet.length > 0) hasLyrics = true;
  }
  if (hasLyrics) {
    $('lyrics-toggle-btn').classList.remove('hidden');
    // Default view: the chords + lyrics sheet when one exists, else plain lyrics
    setLyricsMode(parsedChordSheet && parsedChordSheet.length ? 'chordify' : 'spotify');
  }
}

// ── Autoscroll ────────────────────────────────────────────────────────────────
// Fallback for songs whose lyrics never arrived: with no timestamps to follow,
// the panel is scrolled straight from playback position instead. Deriving the
// position from the clock rather than incrementing a timer means seeking,
// pausing and tempo changes all come out right for free.

export const AS_STEP = 5;              // percentage points per stepper tap
const AS_MIN = 25, AS_MAX = 400;

let songDuration   = 0;
let asEnabled      = false;
let asSpeed        = 100;              // % of "ends exactly when the song does"
let asManualOffset = 0;                // px the user dragged away from that
let asBase         = 0;                // last computed position, before the offset
let asLastSet      = null;             // last scrollTop we wrote, to spot our own events
let asWatching     = false;

export function setSongDuration(sec) { songDuration = sec || 0; }
export function getAutoscrollSpeed() { return asSpeed; }
export function isAutoscrollOn() { return asEnabled; }

// True when nothing in the view carries a timestamp, so autoscroll is the only
// way for it to keep up with the song.
export function needsAutoscroll() {
  if (parsedChordSheet && parsedChordSheet.length) {
    return !parsedChordSheet.some(s => s.time !== null);
  }
  return !!plainLyricsText;
}

export function setAutoscroll(on) {
  asEnabled      = !!on && hasLyrics;
  asManualOffset = 0;
  asLastSet      = null;
  if (asEnabled) watchManualScroll();
  syncAutoscrollPanels();
  return asEnabled;
}

export function setAutoscrollSpeed(pct) {
  asSpeed = Math.max(AS_MIN, Math.min(AS_MAX, Math.round(pct)));
  return asSpeed;
}

export function adjustAutoscrollSpeed(delta) { return setAutoscrollSpeed(asSpeed + delta); }

function resetAutoscroll() {
  asEnabled      = false;
  asManualOffset = 0;
  asBase         = 0;
  asLastSet      = null;
  songDuration   = 0;
  syncAutoscrollPanels();
}

const AS_PANELS = ['lyrics-chordify-panel', 'lyrics-spotify-panel'];

function scrollPanel() {
  if (lyricsMode === 'chordify') return $('lyrics-chordify-panel');
  if (lyricsMode === 'spotify')  return $('lyrics-spotify-panel');
  return null;
}

// Both panels scroll smoothly by default, which would fight a position written
// every frame — the active one drops to instant scrolling while autoscroll runs.
function syncAutoscrollPanels() {
  const active = asEnabled ? scrollPanel() : null;
  AS_PANELS.forEach(id => $(id).classList.toggle('as-active', $(id) === active));
}

function watchManualScroll() {
  if (asWatching) return;
  asWatching = true;
  AS_PANELS.forEach(id => {
    $(id).addEventListener('scroll', () => {
      const panel = scrollPanel();
      if (!asEnabled || !panel || panel.id !== id) return;
      // Ignore the scroll events our own writes generate
      if (asLastSet !== null && Math.abs(panel.scrollTop - asLastSet) <= 2) return;
      // A drag is a deliberate nudge — hold that alignment from here on
      asManualOffset = panel.scrollTop - asBase;
    }, { passive: true });
  });
}

function applyAutoscroll(t) {
  const panel = scrollPanel();
  if (!panel || !songDuration) return;
  const range = panel.scrollHeight - panel.clientHeight;
  if (range <= 0) return;
  asBase = (t / songDuration) * range * (asSpeed / 100);
  const target = Math.max(0, Math.min(range, asBase + asManualOffset));
  if (Math.abs(panel.scrollTop - target) < 0.5) return;
  panel.scrollTop = target;
  asLastSet = panel.scrollTop;
}

export function parseLRC(lrc) {
  const lines = [];
  for (const line of (lrc || '').split('\n')) {
    const m = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
    if (!m) continue;
    const text = m[4].trim();
    if (text) lines.push({
      time: +m[1] * 60 + +m[2] + +m[3] / (m[3].length === 3 ? 1000 : 100),
      text,
    });
  }
  return lines;
}

// ── Chord sheet parsing ───────────────────────────────────────────────────────

const SECTION_LINE_RE = /^\[([^\]]+)\]\s*(.*)$/; // [Label] optional-rest

function isChordLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).every(t => CHORD_TOKEN_RE.test(t));
}

function isMetadataLine(trimmed) {
  // e.g. "Tono: G", "BPM: 120" — key: value lines that are not lyrics
  return /^\w+:\s/.test(trimmed);
}

function parseChordSheet(text) {
  const lines = text.split('\n');
  const sections = [];
  let i = 0;

  while (i < lines.length) {
    const line    = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // Section label: [Primera Parte] or [Intro] Em D C ...
    const sectionMatch = trimmed.match(SECTION_LINE_RE);
    if (sectionMatch) {
      const label = sectionMatch[1].trim();
      const rest  = sectionMatch[2].trim();
      if (!rest) {
        sections.push({ sectionLabel: label, chordLine: '', lyricLine: '', isMetadata: false });
      } else if (isChordLine(rest)) {
        sections.push({ sectionLabel: label, chordLine: rest, lyricLine: '', isMetadata: false });
      } else {
        sections.push({ sectionLabel: label, chordLine: '', lyricLine: rest, isMetadata: false });
      }
      i++;
      continue;
    }

    // Metadata line: "Tono: G", "BPM: 120"
    if (isMetadataLine(trimmed)) {
      sections.push({ sectionLabel: null, chordLine: '', lyricLine: trimmed, isMetadata: true });
      i++;
      continue;
    }

    // Chord line (preserve original spacing for horizontal positioning)
    if (isChordLine(line)) {
      const chordLine = line;
      const nextLine  = i + 1 < lines.length ? lines[i + 1] : '';
      const nextTrimmed = nextLine.trim();
      // Pair with the next lyric line (not another chord line, not a section label)
      if (nextTrimmed && !isChordLine(nextLine) && !nextTrimmed.match(SECTION_LINE_RE)) {
        // Keep the lyric's leading spaces — chords are positioned by column
        sections.push({ sectionLabel: null, chordLine, lyricLine: nextLine.trimEnd(), isMetadata: false });
        i += 2;
      } else {
        sections.push({ sectionLabel: null, chordLine, lyricLine: '', isMetadata: false });
        i++;
      }
      continue;
    }

    // Lyric or other text line
    sections.push({ sectionLabel: null, chordLine: '', lyricLine: line.trimEnd(), isMetadata: false });
    i++;
  }

  return sections.filter(s => s.sectionLabel !== null || s.chordLine || s.lyricLine);
}

function assignTimestamps(sections) {
  if (!parsedLyrics || !parsedLyrics.length) {
    return sections.map(s => ({ ...s, time: null }));
  }

  // Collect which sections need timestamps and their lyric text
  const lyricEntries = [];
  sections.forEach((s, i) => {
    if (s.lyricLine && !s.sectionLabel && !s.isMetadata) {
      lyricEntries.push({ idx: i, text: s.lyricLine });
    }
  });

  // Smart text-similarity match: each chord sheet line finds the best LRC line
  // Monotonically ordered — earlier lines can't match later LRC positions than subsequent lines
  const matched = smartMatchLyrics(lyricEntries.map(e => e.text), parsedLyrics);

  const timeMap = new Map(lyricEntries.map((e, i) => [e.idx, matched[i]]));
  return sections.map((s, i) => ({ ...s, time: timeMap.get(i) ?? null }));
}

// A chorus phrase can appear identically half a dozen times in one LRC, so raw
// score alone will happily match the first chorus line to the last one in the
// song. Since matching only ever moves forward, one such jump strands every
// remaining line without a timestamp and the sheet stops following playback.
// Distance is therefore charged against the score: a decent match a line or two
// ahead outranks a perfect one minutes away.
const MATCH_FLOOR      = 0.25; // below this, the line stays untimed
const MATCH_NEAR_ENOUGH = 0.65; // stop looking once something scores this well
const MATCH_DECAY      = 0.03; // penalty per LRC line of distance
const MATCH_DECAY_CAP  = 0.6;  // never discount a candidate to nothing

function smartMatchLyrics(sheetLines, lrcLines) {
  const result   = new Array(sheetLines.length).fill(null);
  let lastLrcIdx = -1;

  console.group('[JamMate] LRC lines available');
  lrcLines.forEach((l, i) => console.log(`LRC[${i}] ${String(l.time).padStart(7)}s  "${l.text}"`));
  console.groupEnd();

  console.group('[JamMate] Chord sheet → LRC matching');
  for (let i = 0; i < sheetLines.length; i++) {
    let bestScore = MATCH_FLOOR;
    let bestIdx   = -1;
    let bestRaw   = 0;

    // Allow re-scoring the last-matched LRC line so that chord-sheet lines
    // which are sub-phrases of one LRC line don't jump forward on the second hit.
    const startJ = lastLrcIdx < 0 ? 0 : lastLrcIdx;
    for (let j = startJ; j < lrcLines.length; j++) {
      const raw   = wordOverlapScore(sheetLines[i], lrcLines[j].text);
      const score = raw * (1 - Math.min(MATCH_DECAY_CAP, MATCH_DECAY * (j - startJ)));
      if (score > bestScore) { bestScore = score; bestIdx = j; bestRaw = raw; }
      if (bestScore >= MATCH_NEAR_ENOUGH) break;
    }

    if (bestIdx !== -1) {
      // Sub-phrase re-match (same LRC line as previous): treat as continuation,
      // no independent timestamp so the previous section stays highlighted.
      const isRematch = bestIdx === lastLrcIdx;
      result[i] = isRematch ? null : lrcLines[bestIdx].time;
      if (bestIdx > lastLrcIdx) lastLrcIdx = bestIdx;
      console.log(`${isRematch ? '~' : '✓'} [${String(result[i]).padStart(7)}s] "${sheetLines[i]}" → "${lrcLines[bestIdx].text}" (score ${bestRaw.toFixed(2)}, adjusted ${bestScore.toFixed(2)}, +${bestIdx - startJ})`);
    } else {
      console.log(`✗ no match  "${sheetLines[i]}" (best score below 0.25)`);
    }
  }
  console.groupEnd();

  return result;
}

const _ACCENT_MAP = {
  'á':'a','à':'a','ä':'a','â':'a','ã':'a',
  'é':'e','è':'e','ë':'e','ê':'e',
  'í':'i','ì':'i','ï':'i','î':'i',
  'ó':'o','ò':'o','ö':'o','ô':'o','õ':'o',
  'ú':'u','ù':'u','ü':'u','û':'u',
  'ñ':'n','ç':'c',
};

function wordOverlapScore(a, b) {
  const normalize = s => new Set(
    s.toLowerCase()
      .replace(/[áàäâãéèëêíìïîóòöôõúùüûñç]/g, c => _ACCENT_MAP[c] || c)
      // Held-note padding in Cifra sheets ("you____u", "thro_____ugh"). Dropping
      // the underscores alone leaves a doubled letter, which was enough to push
      // the real match below the near-enough threshold.
      .replace(/([a-z0-9])_+\1/g, '$1')
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/).filter(Boolean)
  );
  const setA = normalize(a);
  const setB = normalize(b);
  if (!setA.size || !setB.size) return 0;
  const intersection = [...setA].filter(w => setB.has(w)).length;
  return (intersection / setA.size + intersection / setB.size) / 2;
}

function highlightChordLine(line) {
  // Escape HTML then wrap each chord token in a span
  const escaped = line
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\S+/g, token => {
    if (CHORD_TOKEN_RE.test(token)) {
      return `<span class="cs-chord-name">${token}</span>`;
    }
    return token;
  });
}

// ── Mode cycling ──────────────────────────────────────────────────────────────

export function getLyricsMode() { return lyricsMode; }

export function setLyricsMode(mode) {
  if (!hasLyrics && mode !== null) return;
  lyricsMode = mode;
  applyLyricsMode();
}

export function cycleLyricsMode() {
  if (!hasLyrics) return;
  if (lyricsMode === null) {
    // Start at chordify if chord sheet present, otherwise spotify
    lyricsMode = parsedChordSheet ? 'chordify' : 'spotify';
  } else if (lyricsMode === 'chordify') {
    lyricsMode = 'spotify';
  } else {
    lyricsMode = null;
  }
  applyLyricsMode();
}

function applyLyricsMode() {
  const chordifyPanel = $('lyrics-chordify-panel');
  const spotifyPanel  = $('lyrics-spotify-panel');
  const toggleBtn     = $('lyrics-toggle-btn');
  const modeLabel     = $('lyrics-mode-label');

  chordifyPanel.classList.add('hidden');
  spotifyPanel.classList.add('hidden');
  spotifyPanel.classList.remove('spotify-active');
  $('lyrics-spotify-content').style.paddingTop    = '';
  $('lyrics-spotify-content').style.paddingBottom = '';
  toggleBtn.style.color = '';

  if (lyricsMode === 'chordify') {
    chordifyPanel.classList.remove('hidden');
    modeLabel.textContent = 'CHORDS';
    toggleBtn.style.color = '#22c55e';
    renderChordsPlusLyrics();
    reapplyChordSheetActive();
    setTimeout(() => {
      const el = $(`cs-${currentLyricIdx}`);
      if (el && !asEnabled) centerChordSheetSection(el, 'auto');
    }, 50);
  } else if (lyricsMode === 'spotify') {
    spotifyPanel.classList.remove('hidden');
    spotifyPanel.classList.add('spotify-active');
    modeLabel.textContent = 'LYRICS';
    toggleBtn.style.color = '#22c55e';
    renderLyricsSpotify();
    const padH = Math.round(spotifyPanel.offsetHeight * 0.3);
    $('lyrics-spotify-content').style.paddingTop    = `${padH}px`;
    $('lyrics-spotify-content').style.paddingBottom = `${padH}px`;
    setTimeout(() => {
      const idx = currentLyricIdx >= 0 ? currentLyricIdx : 0;
      const el  = $(`lyric-s-${idx}`);
      if (el && !asEnabled) el.scrollIntoView({ block: 'center' });
    }, 50);
  } else {
    modeLabel.textContent = 'OFF';
  }

  // A different panel means different geometry, so any nudge no longer applies
  asManualOffset = 0;
  asLastSet      = null;
  syncAutoscrollPanels();
}

// ── Paired wrapping ───────────────────────────────────────────────────────────
// Chord and lyric lines are positioned by column, so they cannot be left to wrap
// on their own — `pre-wrap` breaks each at its own width and slides every chord
// off its syllable. Both halves of a pair are therefore cut at the *same*
// column, picked so it lands neither inside a chord token nor inside a word.

const CS_PROBE_LEN = 100; // chars measured to get the glyph advance
const CS_MIN_COLS  = 12;  // never wrap tighter than this, however narrow the panel

let csCols = 0;           // column budget, measured from the rendered panel

// Measures against real elements rather than assuming a glyph ratio, so it stays
// right across --cs-font-size changes and whatever monospace the device picks.
function measureChordSheetCols() {
  const container = $('lyrics-chordify-content');
  if (!container) return 0;

  const section = document.createElement('div');
  section.className     = 'cs-section';
  section.style.visibility = 'hidden';

  // In flow, so its width is the real budget a lyric line is given.
  const box = document.createElement('pre');
  box.className = 'cs-chord-line';

  // Out of flow, so it shrink-wraps and reports the true advance per char.
  const glyphs = document.createElement('span');
  glyphs.style.position   = 'absolute';
  glyphs.style.whiteSpace = 'pre';
  glyphs.textContent      = 'M'.repeat(CS_PROBE_LEN);

  box.appendChild(glyphs);
  section.appendChild(box);
  container.appendChild(section);

  const charW  = glyphs.getBoundingClientRect().width / CS_PROBE_LEN;
  const availW = box.clientWidth;
  container.removeChild(section);

  // Panel not laid out yet — caller falls back to not wrapping.
  if (!(charW > 0) || !(availW > 0)) return 0;
  return Math.max(CS_MIN_COLS, Math.floor(availW / charW));
}

const solid = (s, i) => i >= 0 && i < s.length && !/\s/.test(s[i]);

// A cut at column b is inside a token when it has non-space on both sides.
const cutOk = (s, b) => !(solid(s, b - 1) && solid(s, b));

function leadingSpaces(s) { return s.length - s.trimStart().length; }

function safeBreak(chordLine, lyricLine, cols) {
  // Widest cut that splits neither a chord nor a word.
  for (let b = cols; b > 0; b--) {
    if (cutOk(chordLine, b) && cutOk(lyricLine, b)) return b;
  }
  // Nothing clean fits: split the word rather than run off-screen, but still
  // keep chord tokens whole — a halved chord name is unreadable, a halved word
  // is merely ugly.
  for (let b = cols; b > 0; b--) {
    if (cutOk(chordLine, b)) return b;
  }
  return cols;
}

// Only the indent the two continuations share can be dropped; trimming them
// separately would undo the alignment the shared cut just preserved.
function commonIndent(a, b) {
  if (!a.trim()) return leadingSpaces(b);
  if (!b.trim()) return leadingSpaces(a);
  return Math.min(leadingSpaces(a), leadingSpaces(b));
}

function wrapPair(chordLine, lyricLine, cols) {
  if (!cols) return [{ chord: chordLine, lyric: lyricLine }];

  const out = [];
  let chord = chordLine, lyric = lyricLine;

  for (;;) {
    if (chord.trimEnd().length <= cols && lyric.trimEnd().length <= cols) {
      out.push({ chord, lyric });
      break;
    }

    const b = safeBreak(chord, lyric, cols);
    out.push({ chord: chord.slice(0, b), lyric: lyric.slice(0, b) });

    const chordRest = chord.slice(b);
    const lyricRest = lyric.slice(b);
    const k = commonIndent(chordRest, lyricRest);
    chord = chordRest.slice(k);
    lyric = lyricRest.slice(k);
    if (!chord.trim() && !lyric.trim()) break;
  }

  return out;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

// Vertical-only centering: scrollIntoView would also reset the panel's
// horizontal scroll, undoing any sideways scroll on wide chord sheets.
function centerChordSheetSection(el, behavior) {
  const panel     = $('lyrics-chordify-panel');
  const panelRect = panel.getBoundingClientRect();
  const elRect    = el.getBoundingClientRect();
  const delta     = (elRect.top - panelRect.top) - (panel.clientHeight - elRect.height) / 2;
  panel.scrollTo({ top: panel.scrollTop + delta, behavior });
}

function renderChordsPlusLyrics() {
  const panel     = $('lyrics-chordify-panel');
  const container = $('lyrics-chordify-content');
  container.innerHTML = '';
  if (!parsedChordSheet || !parsedChordSheet.length) return;

  // Padding lets the first and last sections reach the center of the panel.
  const padH = Math.round(panel.offsetHeight * 0.35);
  container.style.paddingTop    = `${padH}px`;
  container.style.paddingBottom = `${padH}px`;
  panel.scrollTop = 0;

  csCols = measureChordSheetCols();

  parsedChordSheet.forEach((section, idx) => {
    const wrapper = document.createElement('div');
    wrapper.id        = `cs-${idx}`;
    wrapper.className = 'cs-section';

    if (section.sectionLabel) {
      const lbl = document.createElement('p');
      lbl.className   = 'cs-section-label';
      lbl.textContent = `[${section.sectionLabel}]`;
      wrapper.appendChild(lbl);
    }

    if (section.isMetadata) {
      const meta = document.createElement('p');
      meta.className   = 'cs-metadata-line';
      meta.textContent = section.lyricLine;
      wrapper.appendChild(meta);
    } else {
      // Segments stay inside this one wrapper: the timestamp indices and the
      // cs-${idx} scroll anchors are per section, not per rendered line.
      wrapPair(section.chordLine, section.lyricLine, csCols).forEach(seg => {
        if (seg.chord.trim()) {
          const pre = document.createElement('pre');
          pre.className = 'cs-chord-line';
          pre.innerHTML = highlightChordLine(seg.chord.trimEnd());
          wrapper.appendChild(pre);
        }

        if (seg.lyric.trim()) {
          const p = document.createElement('p');
          p.className   = 'cs-lyric-line';
          p.textContent = seg.lyric.trimEnd();
          if (section.time !== null) {
            p.style.cursor = 'pointer';
            p.addEventListener('click', () => _seekFn(Math.max(0, section.time - LYRIC_OFFSET_SEC)));
          }
          wrapper.appendChild(p);
        }
      });
    }

    container.appendChild(wrapper);
  });
}

// Rotating the phone changes the column budget, and the wrap is baked into the
// DOM rather than left to CSS, so it has to be rebuilt. Re-rendering drops the
// highlight and the scroll position, so both are restored afterwards.
const CS_RESIZE_DEBOUNCE = 150;

let csResizeTimer = null;

function onChordSheetResize() {
  clearTimeout(csResizeTimer);
  csResizeTimer = setTimeout(() => {
    if (lyricsMode !== 'chordify' || !parsedChordSheet) return;
    // Height-only changes (phone URL bar hiding) don't affect the wrap.
    if (measureChordSheetCols() === csCols) return;
    renderChordsPlusLyrics();
    const el = reapplyChordSheetActive();
    if (el && !asEnabled) centerChordSheetSection(el, 'auto');
    // Panel geometry changed, so a previous drag no longer means anything.
    asManualOffset = 0;
    asLastSet      = null;
  }, CS_RESIZE_DEBOUNCE);
}

window.addEventListener('resize', onChordSheetResize);
window.addEventListener('orientationchange', onChordSheetResize);

function renderLyricsSpotify() {
  const container = $('lyrics-spotify-content');
  container.innerHTML = '';
  if (parsedLyrics && parsedLyrics.length) {
    parsedLyrics.forEach((line, idx) => {
      const p = document.createElement('p');
      p.id        = `lyric-s-${idx}`;
      p.className = lyricSpotifyClass(idx, currentLyricIdx);
      p.textContent = line.text;
      p.addEventListener('click', () => _seekFn(Math.max(0, line.time - LYRIC_OFFSET_SEC)));
      container.appendChild(p);
    });
  } else if (plainLyricsText) {
    const pre = document.createElement('pre');
    pre.className   = 'text-center text-[#86efac] text-base whitespace-pre-wrap font-sans leading-relaxed opacity-70';
    pre.textContent = plainLyricsText;
    container.appendChild(pre);
  }
}

function lyricSpotifyClass(idx, activeIdx) {
  if (activeIdx < 0) {
    const dist = idx;
    if (dist === 0) return 'text-center text-[#86efac] text-base md:text-2xl opacity-40 py-1.5 md:py-3 cursor-pointer leading-snug';
    if (dist === 1) return 'text-center text-[#86efac] text-sm md:text-xl opacity-20 py-1 md:py-2 cursor-pointer leading-snug';
    if (dist === 2) return 'text-center text-[#86efac] text-xs md:text-base opacity-10 py-0.5 md:py-1.5 cursor-pointer leading-snug';
    return 'text-center text-xs opacity-0 py-0.5 cursor-pointer';
  }
  const dist = Math.abs(idx - activeIdx);
  if (dist === 0) return 'text-center text-[#f0fdf4] font-bold text-xl md:text-4xl py-3 md:py-5 cursor-pointer leading-snug';
  if (dist === 1) return 'text-center text-[#86efac] text-base md:text-2xl opacity-55 py-1.5 md:py-3 cursor-pointer leading-snug';
  if (dist === 2) return 'text-center text-[#86efac] text-sm md:text-xl opacity-25 py-1 md:py-2 cursor-pointer leading-snug';
  return 'text-center text-xs opacity-0 py-0.5 cursor-pointer';
}

// ── Tick / sync ───────────────────────────────────────────────────────────────

export function updateLyricIdx(t) {
  if (!lyricsMode) return;
  if (asEnabled) applyAutoscroll(t);
  const tAhead = t + LYRIC_OFFSET_SEC;

  if (lyricsMode === 'chordify' && parsedChordSheet) {
    // No lookahead for chord sheet — chords are already visible above the lyric
    let idx = -1;
    for (let i = parsedChordSheet.length - 1; i >= 0; i--) {
      if (parsedChordSheet[i].time !== null && parsedChordSheet[i].time <= t) {
        idx = i;
        break;
      }
    }
    if (idx === currentLyricIdx) return;
    const prev = currentLyricIdx;
    currentLyricIdx = idx;
    updateChordSheetDisplay(prev);
    return;
  }

  if (!parsedLyrics || !parsedLyrics.length) return;
  let idx = -1;
  for (let i = parsedLyrics.length - 1; i >= 0; i--) {
    if (parsedLyrics[i].time <= tAhead) { idx = i; break; }
  }
  if (idx === currentLyricIdx) return;
  const prev  = currentLyricIdx;
  currentLyricIdx = idx;
  updateLyricDisplay(prev, idx);
}

// The new index is read from currentLyricIdx (already advanced by the caller) so
// that the activate half can be shared with the render paths.
function updateChordSheetDisplay(prevIdx) {
  // Deactivate prev section and any null-timestamp continuations that follow it.
  if (prevIdx >= 0) {
    let i = prevIdx;
    while (i < parsedChordSheet.length) {
      const el = $(`cs-${i}`);
      if (el) el.classList.remove('cs-active');
      i++;
      if (i >= parsedChordSheet.length || parsedChordSheet[i].time !== null) break;
    }
  }
  // Activate new section and any null-timestamp continuations that follow it.
  const el = reapplyChordSheetActive();
  // Autoscroll owns the scroll position while it runs — highlight only
  if (el && !asEnabled) centerChordSheetSection(el, 'smooth');
}

// Rendering builds fresh sections with no highlight, so whichever line the song
// is already on has to be re-marked — otherwise it stays dim until the next one
// starts. Returns the active section element, if there is one.
function reapplyChordSheetActive() {
  if (currentLyricIdx < 0 || !parsedChordSheet) return null;
  const el = $(`cs-${currentLyricIdx}`);
  if (el) el.classList.add('cs-active');
  let j = currentLyricIdx + 1;
  while (j < parsedChordSheet.length && parsedChordSheet[j].time === null) {
    const contEl = $(`cs-${j}`);
    if (contEl) contEl.classList.add('cs-active');
    j++;
  }
  return el;
}

function updateLyricDisplay(prevIdx, newIdx) {
  if (lyricsMode === 'spotify') {
    const range    = 5;
    const toUpdate = new Set();
    for (let d = -range; d <= range; d++) {
      if (prevIdx + d >= 0) toUpdate.add(prevIdx + d);
      if (newIdx  + d >= 0) toUpdate.add(newIdx  + d);
    }
    toUpdate.forEach(i => {
      const el = $(`lyric-s-${i}`);
      if (el) el.className = lyricSpotifyClass(i, newIdx);
    });
    if (newIdx >= 0 && !asEnabled) {
      const el = $(`lyric-s-${newIdx}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}
