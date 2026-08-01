'use strict';

import { updateLyricIdx } from './chords.js';
import { keepScreenAwake, releaseScreenAwake } from './wake-lock.js';

const STEM_ORDER  = ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other'];
const STEM_COLORS = {
  drums: '#ef4444', bass: '#3b82f6', guitar: '#22c55e',
  piano: '#a855f7', vocals: '#f59e0b', other: '#94a3b8',
};
const STEM_ICONS = {
  drums: '🥁', bass: '🎵', guitar: '🎸', piano: '🎹', vocals: '🎤', other: '〜',
};

const $ = id => document.getElementById(id);

const fmtTime = s => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

let audioCtx     = null;
let masterGain   = null;
let stemsMap     = {};
let isPlaying    = false;
let startTime    = 0;
let offsetSec    = 0;
let totalDur     = 0;
let rafId        = null;
let masterVolume = 1.0;
let prevVolume   = 1.0;
let _playbackRate = 1.0;

// ── Audio context ─────────────────────────────────────────────────────────────

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = masterVolume;
    masterGain.connect(audioCtx.destination);
  }
}

// ── Stems ─────────────────────────────────────────────────────────────────────

// Song loading is a chain of awaits that appends stem buttons as each one
// decodes. On a slow connection a second tap would start a parallel chain and
// both would append into the same grid, rendering every stem twice. Each load
// takes a token; every step checks it is still the current one and bails if not.
let loadToken = 0;
let loadAbort = null;

function cancelLoad() {
  loadToken++;
  loadAbort?.abort();
  loadAbort = null;
}

export function beginLoad() {
  cancelLoad();
  loadAbort = new AbortController();
  return { id: loadToken, signal: loadAbort.signal };
}

export function isStaleLoad(load) { return !load || load.id !== loadToken; }

export function resetPlayer() {
  cancelLoad();
  stopAll();
  stemsMap = {};
  totalDur = 0;
}

// A stem that dies on a flaky connection used to vanish from the grid with no
// notice. Each one now gets STEM_RETRIES attempts with backoff, and a stem that
// exhausts them stays in the grid as a tappable retry tile.
const STEM_RETRIES  = 3;
const RETRY_BACKOFF = [400, 1200];   // ms before attempt 2 and attempt 3

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function fetchStemBuffer(jobId, sf, load, onAttempt) {
  for (let attempt = 1; ; attempt++) {
    onAttempt?.(attempt);
    try {
      const resp = await fetch(`/api/audio/${jobId}/${sf}`, { signal: load.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ab = await resp.arrayBuffer();
      // A truncated body fails here rather than at fetch, so decode retries too
      return await audioCtx.decodeAudioData(ab);
    } catch (e) {
      if (attempt >= STEM_RETRIES || isStaleLoad(load) || e.name === 'AbortError') throw e;
      await sleep(RETRY_BACKOFF[attempt - 1] ?? 1200, load.signal);
    }
  }
}

// Every stem state (pending / loaded / failed) renders a fresh button under the
// same id and replaces the previous one, so stale listeners can't pile up.
const stemFace = (name, icon) =>
  `<span style="font-size:1.2rem">${icon}</span><span>${name.toUpperCase()}</span>`;

function makePendingTile(name) {
  const btn = document.createElement('button');
  btn.id        = `stem-${name}`;
  btn.className = 'stem-btn stem-pending';
  btn.disabled  = true;
  btn.innerHTML = stemFace(name, STEM_ICONS[name] || '♪');
  return btn;
}

function adoptStem(name, buf) {
  const gain = audioCtx.createGain();
  gain.connect(masterGain);
  const s = stemsMap[name] = { buffer: buf, source: null, gain, muted: false };
  if (buf.duration > totalDur) {
    totalDur = buf.duration;
    $('time-total').textContent = fmtTime(totalDur);
  }

  const color = STEM_COLORS[name] || '#94a3b8';
  const btn   = document.createElement('button');
  btn.id        = `stem-${name}`;
  btn.className = 'stem-btn';
  btn.style.color           = color;
  btn.style.borderColor     = color;
  btn.style.backgroundColor = color + '15';
  btn.innerHTML = stemFace(name, STEM_ICONS[name] || '♪');
  btn.addEventListener('click', () => toggleStem(name));

  let lpTimer = null;
  btn.addEventListener('pointerdown', () => { lpTimer = setTimeout(() => soloStem(name), 600); });
  ['pointerup', 'pointercancel'].forEach(ev => btn.addEventListener(ev, () => clearTimeout(lpTimer)));
  $(`stem-${name}`)?.replaceWith(btn);

  // A stem recovered mid-song joins the running mix in sync rather than staying
  // silent until the next play
  if (isPlaying) {
    const when   = audioCtx.currentTime + 0.05;
    const offset = (when - startTime) * _playbackRate;
    if (offset < buf.duration) {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = _playbackRate;
      src.connect(gain);
      src.start(when, offset);
      s.source = src;
    }
  }
}

function markStemFailed(jobId, sf, name, load) {
  const btn = document.createElement('button');
  btn.id        = `stem-${name}`;
  btn.className = 'stem-btn stem-failed';
  btn.title     = `${name} failed to load — tap to retry`;
  btn.innerHTML = stemFace(name, '↻');
  btn.addEventListener('click', () => retryStem(jobId, sf, name, load));
  $(`stem-${name}`)?.replaceWith(btn);
}

async function retryStem(jobId, sf, name, load) {
  if (isStaleLoad(load)) return;
  const btn = $(`stem-${name}`);
  if (btn) {
    btn.disabled = true;
    btn.classList.replace('stem-failed', 'stem-pending');
    btn.title = `Retrying ${name}…`;
  }
  try {
    const buf = await fetchStemBuffer(jobId, sf, load);
    if (isStaleLoad(load)) return;
    adoptStem(name, buf);
  } catch (e) {
    if (isStaleLoad(load) || e.name === 'AbortError') return;
    console.error(`stem retry failed: ${sf}`, e);
    markStemFailed(jobId, sf, name, load);
  }
}

export async function loadStems(jobId, stemFiles, load) {
  if (isStaleLoad(load)) return;
  ensureAudioCtx();

  const grid   = $('stem-grid');
  grid.innerHTML = '';
  const sorted = [...stemFiles].sort((a, b) => {
    const n = f => f.replace(/\.(ogg|wav|mp3)$/, '');
    return (STEM_ORDER.indexOf(n(a)) + 99) % 99 - (STEM_ORDER.indexOf(n(b)) + 99) % 99;
  });

  for (let i = 0; i < sorted.length; i++) {
    const sf   = sorted[i];
    const name = sf.replace(/\.(ogg|wav|mp3)$/, '');
    if (isStaleLoad(load)) return;

    // The tile goes in now so the grid keeps STEM_ORDER even if this stem ends up
    // failing and only arrives later via retry.
    const label = `Loading ${name} (${i + 1}/${sorted.length})…`;
    grid.appendChild(makePendingTile(name));
    try {
      const buf = await fetchStemBuffer(jobId, sf, load, attempt => {
        $('stem-loading-text').textContent =
          attempt === 1 ? label : `${label} retry ${attempt - 1}/${STEM_RETRIES - 1}`;
      });
      if (isStaleLoad(load)) return;
      adoptStem(name, buf);
    } catch (e) {
      if (isStaleLoad(load) || e.name === 'AbortError') return;
      console.error(`stem load failed: ${sf}`, e);
      markStemFailed(jobId, sf, name, load);
    }
  }

  if (isStaleLoad(load)) return;
  $('stem-loading').classList.add('hidden');
  $('stem-grid').classList.remove('hidden');
  $('time-total').textContent = fmtTime(totalDur);
}

export function getDuration() { return totalDur; }

export function toggleStem(name) {
  const s = stemsMap[name];
  if (!s) return;
  s.muted = !s.muted;
  s.gain.gain.setTargetAtTime(s.muted ? 0 : 1, audioCtx?.currentTime || 0, 0.02);
  const btn = $(`stem-${name}`);
  btn.classList.toggle('muted', s.muted);
  btn.style.backgroundColor = s.muted ? 'transparent' : (STEM_COLORS[name] || '#94a3b8') + '15';
}

export function soloStem(name) {
  const isSolo = Object.entries(stemsMap).every(([n, s]) => n === name ? !s.muted : s.muted);
  Object.entries(stemsMap).forEach(([n, s]) => {
    s.muted = isSolo ? false : (n !== name);
    s.gain.gain.setTargetAtTime(s.muted ? 0 : 1, audioCtx?.currentTime || 0, 0.02);
    const btn = $(`stem-${n}`);
    if (btn) {
      btn.classList.toggle('muted', s.muted);
      btn.style.backgroundColor = s.muted ? 'transparent' : (STEM_COLORS[n] || '#94a3b8') + '15';
    }
  });
}

// ── Playback ──────────────────────────────────────────────────────────────────

export function togglePlay() { isPlaying ? pauseAll() : play(); }

export function play() {
  if (!audioCtx || !Object.keys(stemsMap).length) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  keepScreenAwake();
  const at = audioCtx.currentTime + 0.05;
  Object.values(stemsMap).forEach(s => {
    const src = audioCtx.createBufferSource();
    src.buffer = s.buffer;
    src.playbackRate.value = _playbackRate;
    src.connect(s.gain);
    src.start(at, offsetSec);
    s.source = src;
  });
  startTime = at - offsetSec / _playbackRate;
  isPlaying = true;
  $('icon-play').classList.add('hidden');
  $('icon-pause').classList.remove('hidden');
  rafId = requestAnimationFrame(tick);
}

export function pauseAll() {
  if (!isPlaying) return;
  offsetSec = (audioCtx.currentTime - startTime) * _playbackRate;
  Object.values(stemsMap).forEach(s => { try { s.source?.stop(0); } catch (e) {} s.source = null; });
  isPlaying = false;
  cancelAnimationFrame(rafId);
  releaseScreenAwake();
  $('icon-play').classList.remove('hidden');
  $('icon-pause').classList.add('hidden');
}

export function stopAll() {
  pauseAll();
  offsetSec = 0;
  $('progress-fill').style.width  = '0%';
  $('time-current').textContent   = '0:00';
}

export function seekTo(e) {
  const rect  = $('progress-bar').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  doSeek(ratio * totalDur);
}

export function touchSeek(e) {
  e.preventDefault();
  const touch = e.touches[0];
  if (!touch) return;
  const rect  = $('progress-bar').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
  doSeek(ratio * totalDur);
}

export function seekRelative(d) { doSeek(offsetSec + d); }

export function doSeek(t) {
  const was = isPlaying;
  if (was) pauseAll();
  offsetSec = Math.max(0, Math.min(totalDur, t));
  updateUI(offsetSec);
  updateLyricIdx(offsetSec);
  if (was) play();
}

function tick() {
  if (!isPlaying) return;
  const elapsed = (audioCtx.currentTime - startTime) * _playbackRate;
  if (elapsed >= totalDur) { pauseAll(); offsetSec = 0; return; }
  updateUI(elapsed);
  updateLyricIdx(elapsed);
  rafId = requestAnimationFrame(tick);
}

function updateUI(t) {
  $('time-current').textContent  = fmtTime(t);
  $('progress-fill').style.width = totalDur ? `${(t / totalDur) * 100}%` : '0%';
}

// ── Volume ────────────────────────────────────────────────────────────────────

export const VOL_STEP = 0.05;   // per stepper tap, matching TEMPO_STEP's 5%

export function setVolume(v) {
  masterVolume = Math.max(0, Math.min(1, v));
  if (masterGain && audioCtx) {
    masterGain.gain.setTargetAtTime(masterVolume, audioCtx.currentTime, 0.05);
  }
  updateVolumeUI();
}

export function adjustVolume(delta) { setVolume(masterVolume + delta); }

export function toggleMute() {
  if (masterVolume > 0) {
    prevVolume = masterVolume;
    setVolume(0);
  } else {
    setVolume(prevVolume > 0 ? prevVolume : 1.0);
  }
}

function updateVolumeUI() {
  const pct   = Math.round(masterVolume * 100);
  const muted = masterVolume === 0;
  $('vol-label').textContent = muted ? 'MUTE' : `${pct}%`;
  $('vol-icon-on').classList.toggle('hidden', muted);
  $('vol-icon-off').classList.toggle('hidden', !muted);
  const reset = $('vol-reset');
  if (reset) {
    reset.classList.toggle('muted', muted);
    reset.classList.toggle('off-normal', !muted && pct !== 100);
  }
  // Dim the stepper at the ends of the range so taps that do nothing look inert
  const down = $('vol-down');
  const up   = $('vol-up');
  if (down) down.disabled = masterVolume <= 0;
  if (up)   up.disabled   = masterVolume >= 1;
}

// ── Fullscreen ────────────────────────────────────────────────────────────────

export function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

document.addEventListener('fullscreenchange', () => {
  const inFs = !!document.fullscreenElement;
  $('fs-icon-enter').classList.toggle('hidden', inFs);
  $('fs-icon-exit').classList.toggle('hidden', !inFs);
  $('fs-label').textContent = inFs ? 'EXIT' : 'FULL';
});

// ── Playback rate (tempo) ─────────────────────────────────────────────────────

const TEMPO_MIN = 0.5;          // 50%
const TEMPO_MAX = 1.5;          // 150%
export const TEMPO_STEP = 5;    // percentage points per stepper tap

export function setPlaybackRate(rate) {
  _playbackRate = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, rate));
  updateTempoUI();
  if (isPlaying) {
    // restart with new rate from current position
    pauseAll();
    play();
  }
}

export function setTempoPercent(pct) { setPlaybackRate(pct / 100); }

export function adjustTempo(deltaPct) {
  setPlaybackRate((Math.round(_playbackRate * 100) + deltaPct) / 100);
}

function updateTempoUI() {
  const pct = Math.round(_playbackRate * 100);
  $('tempo-label').textContent = `${pct}%`;
  $('tempo-reset').classList.toggle('off-normal', pct !== 100);
  // Dim the stepper at the ends of the range so taps that do nothing look inert
  $('tempo-down').disabled = _playbackRate <= TEMPO_MIN;
  $('tempo-up').disabled   = _playbackRate >= TEMPO_MAX;
}
