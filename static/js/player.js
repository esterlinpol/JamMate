'use strict';

import { updateLyricIdx } from './chords.js';

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

export function resetPlayer() {
  stopAll();
  stemsMap = {};
  totalDur = 0;
}

export async function loadStems(jobId, stemFiles) {
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
    $('stem-loading-text').textContent = `Loading ${name} (${i + 1}/${sorted.length})…`;

    try {
      const resp = await fetch(`/api/audio/${jobId}/${sf}`);
      const ab   = await resp.arrayBuffer();
      const buf  = await audioCtx.decodeAudioData(ab);
      const gain = audioCtx.createGain();
      gain.connect(masterGain);
      stemsMap[name] = { buffer: buf, source: null, gain, muted: false };
      if (buf.duration > totalDur) totalDur = buf.duration;

      const color = STEM_COLORS[name] || '#94a3b8';
      const btn   = document.createElement('button');
      btn.id        = `stem-${name}`;
      btn.className = 'stem-btn';
      btn.style.color           = color;
      btn.style.borderColor     = color;
      btn.style.backgroundColor = color + '15';
      btn.innerHTML = `<span style="font-size:1.2rem">${STEM_ICONS[name] || '♪'}</span><span>${name.toUpperCase()}</span>`;
      btn.addEventListener('click', () => toggleStem(name));

      let lpTimer = null;
      btn.addEventListener('pointerdown', () => { lpTimer = setTimeout(() => soloStem(name), 600); });
      ['pointerup', 'pointercancel'].forEach(ev => btn.addEventListener(ev, () => clearTimeout(lpTimer)));
      grid.appendChild(btn);
    } catch (e) {
      console.error(`stem load failed: ${sf}`, e);
    }
  }

  $('stem-loading').classList.add('hidden');
  $('stem-grid').classList.remove('hidden');
  $('time-total').textContent = fmtTime(totalDur);
}

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
  const at = audioCtx.currentTime + 0.05;
  Object.values(stemsMap).forEach(s => {
    const src = audioCtx.createBufferSource();
    src.buffer = s.buffer;
    src.connect(s.gain);
    src.start(at, offsetSec);
    s.source = src;
  });
  startTime = at - offsetSec;
  isPlaying = true;
  $('icon-play').classList.add('hidden');
  $('icon-pause').classList.remove('hidden');
  rafId = requestAnimationFrame(tick);
}

export function pauseAll() {
  if (!isPlaying) return;
  offsetSec = audioCtx.currentTime - startTime;
  Object.values(stemsMap).forEach(s => { try { s.source?.stop(0); } catch (e) {} s.source = null; });
  isPlaying = false;
  cancelAnimationFrame(rafId);
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
  const elapsed = audioCtx.currentTime - startTime;
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
