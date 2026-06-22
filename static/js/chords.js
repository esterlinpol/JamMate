'use strict';

const LYRIC_OFFSET_SEC = 0.5;

const $ = id => document.getElementById(id);

let lyricsMode      = null;
let parsedLyrics    = null;
let plainLyricsText = null;
let currentLyricIdx = -1;
let hasLyrics       = false;
let _seekFn         = () => {};

export function setSeekFn(fn) { _seekFn = fn; }

export function resetLyrics() {
  lyricsMode      = null;
  parsedLyrics    = null;
  plainLyricsText = null;
  currentLyricIdx = -1;
  hasLyrics       = false;
  $('lyrics-toggle-btn').classList.add('hidden');
  $('lyrics-chordify-panel').classList.add('hidden');
  $('lyrics-spotify-panel').classList.add('hidden');
  $('lyrics-mode-label').textContent = 'OFF';
}

export function initLyrics(chordData, chordSource) {
  if (chordSource === 'lrclib' && chordData) {
    parsedLyrics = parseLRC(chordData);
    hasLyrics    = parsedLyrics.length > 0;
  } else if (chordSource === 'lrclib-plain' && chordData) {
    plainLyricsText = chordData;
    hasLyrics       = true;
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

export function cycleLyricsMode() {
  if (!hasLyrics) return;
  lyricsMode = lyricsMode === null ? 'chordify' : lyricsMode === 'chordify' ? 'spotify' : null;
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
    renderLyricsChordify();
    setTimeout(() => {
      const el = $(`lyric-c-${currentLyricIdx}`);
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

function renderLyricsChordify() {
  const container = $('lyrics-chordify-content');
  container.innerHTML = '';
  if (parsedLyrics && parsedLyrics.length) {
    parsedLyrics.forEach((line, idx) => {
      const p = document.createElement('p');
      p.id        = `lyric-c-${idx}`;
      p.className = lyricChordifyClass(idx);
      p.textContent = line.text;
      p.addEventListener('click', () => _seekFn(Math.max(0, line.time - LYRIC_OFFSET_SEC)));
      container.appendChild(p);
    });
  } else if (plainLyricsText) {
    const pre = document.createElement('pre');
    pre.className   = 'text-[#86efac] text-sm whitespace-pre-wrap font-sans leading-relaxed opacity-70';
    pre.textContent = plainLyricsText;
    container.appendChild(pre);
  }
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

function lyricChordifyClass(idx) {
  return idx === currentLyricIdx
    ? 'text-[#f0fdf4] font-semibold text-sm py-1 cursor-pointer leading-snug'
    : 'text-[#86efac] opacity-40 text-sm py-1 cursor-pointer leading-snug hover:opacity-70';
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

export function updateLyricIdx(t) {
  if (!parsedLyrics || !parsedLyrics.length || !lyricsMode) return;
  const tAhead = t + LYRIC_OFFSET_SEC;
  let idx = -1;
  for (let i = parsedLyrics.length - 1; i >= 0; i--) {
    if (parsedLyrics[i].time <= tAhead) { idx = i; break; }
  }
  if (idx === currentLyricIdx) return;
  const prev  = currentLyricIdx;
  currentLyricIdx = idx;
  updateLyricDisplay(prev, idx);
}

function updateLyricDisplay(prevIdx, newIdx) {
  if (lyricsMode === 'chordify') {
    if (prevIdx >= 0) {
      const el = $(`lyric-c-${prevIdx}`);
      if (el) el.className = lyricChordifyClass(prevIdx);
    }
    if (newIdx >= 0) {
      const el = $(`lyric-c-${newIdx}`);
      if (el) {
        el.className = lyricChordifyClass(newIdx);
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  } else if (lyricsMode === 'spotify') {
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
