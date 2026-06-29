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
  if (hasLyrics) $('lyrics-toggle-btn').classList.remove('hidden');
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
        sections.push({ sectionLabel: null, chordLine, lyricLine: nextTrimmed, isMetadata: false });
        i += 2;
      } else {
        sections.push({ sectionLabel: null, chordLine, lyricLine: '', isMetadata: false });
        i++;
      }
      continue;
    }

    // Lyric or other text line
    sections.push({ sectionLabel: null, chordLine: '', lyricLine: trimmed, isMetadata: false });
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

function smartMatchLyrics(sheetLines, lrcLines) {
  const result   = new Array(sheetLines.length).fill(null);
  let lastLrcIdx = -1;

  console.group('[JamMate] LRC lines available');
  lrcLines.forEach((l, i) => console.log(`LRC[${i}] ${String(l.time).padStart(7)}s  "${l.text}"`));
  console.groupEnd();

  console.group('[JamMate] Chord sheet → LRC matching');
  for (let i = 0; i < sheetLines.length; i++) {
    let bestScore = 0.25;
    let bestIdx   = -1;

    // Allow re-scoring the last-matched LRC line so that chord-sheet lines
    // which are sub-phrases of one LRC line don't jump forward on the second hit.
    // Early-exit at 0.65: a nearby good-enough match beats a distant perfect one.
    const startJ = lastLrcIdx < 0 ? 0 : lastLrcIdx;
    for (let j = startJ; j < lrcLines.length; j++) {
      const score = wordOverlapScore(sheetLines[i], lrcLines[j].text);
      if (score > bestScore) { bestScore = score; bestIdx = j; }
      if (bestScore >= 0.65) break;
    }

    if (bestIdx !== -1) {
      // Sub-phrase re-match (same LRC line as previous): treat as continuation,
      // no independent timestamp so the previous section stays highlighted.
      const isRematch = bestIdx === lastLrcIdx;
      result[i] = isRematch ? null : lrcLines[bestIdx].time;
      if (bestIdx > lastLrcIdx) lastLrcIdx = bestIdx;
      console.log(`${isRematch ? '~' : '✓'} [${String(result[i]).padStart(7)}s] "${sheetLines[i]}" → "${lrcLines[bestIdx].text}" (score ${bestScore.toFixed(2)})`);
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
    setTimeout(() => {
      const el = $(`cs-${currentLyricIdx}`);
      if (el) el.scrollIntoView({ block: 'center' });
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
      if (el) el.scrollIntoView({ block: 'center' });
    }, 50);
  } else {
    modeLabel.textContent = 'OFF';
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

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
      if (section.chordLine) {
        const pre = document.createElement('pre');
        pre.className = 'cs-chord-line';
        pre.innerHTML = highlightChordLine(section.chordLine);
        wrapper.appendChild(pre);
      }

      if (section.lyricLine) {
        const p = document.createElement('p');
        p.className   = 'cs-lyric-line';
        p.textContent = section.lyricLine;
        if (section.time !== null) {
          p.style.cursor = 'pointer';
          p.addEventListener('click', () => _seekFn(Math.max(0, section.time - LYRIC_OFFSET_SEC)));
        }
        wrapper.appendChild(p);
      }
    }

    container.appendChild(wrapper);
  });
}

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
    updateChordSheetDisplay(prev, idx);
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

function updateChordSheetDisplay(prevIdx, newIdx) {
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
  if (newIdx >= 0) {
    const el = $(`cs-${newIdx}`);
    if (el) {
      el.classList.add('cs-active');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    let j = newIdx + 1;
    while (j < parsedChordSheet.length && parsedChordSheet[j].time === null) {
      const contEl = $(`cs-${j}`);
      if (contEl) contEl.classList.add('cs-active');
      j++;
    }
  }
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
    if (newIdx >= 0) {
      const el = $(`lyric-s-${newIdx}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}
