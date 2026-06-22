// Chord beat-grid strip: rendering, playback sync, diagram row, tempo, editor

import { renderChordSVG, fetchChords } from './chord-lib.js';

const BEAT_BOX_PX = 52;       // width of each beat box in pixels
const ACTIVE_RATIO = 0.4;  // active beat sits at 40% from the left (just left of center)
const DIAGRAMS_COUNT = 5;     // number of diagrams shown in the diagram row (2 past + current + 2 upcoming)

// ── State ─────────────────────────────────────────────────────────────────────

let beatTimes = [];            // array of beat timestamps in seconds
let chordTimeline = [];        // [{time, name}] sorted by time
let chordLib = {};             // {name: chordObj} lookup from library
let showDiagrams = true;
let showFingers = true;
let lastBeatIdx = 0;
let playbackRate = 1.0;
let isEditing = false;
let currentJobId = null;
let pendingPickerBeat = null;  // beat index awaiting chord assignment in edit mode

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initChordPlay(jobId, stemData) {
  currentJobId = jobId;
  beatTimes = stemData.beat_times ? JSON.parse(stemData.beat_times) : [];
  chordTimeline = parseLrcChords(stemData.song_chord_data || '');

  const lib = await fetchChords();
  chordLib = Object.fromEntries(lib.map(c => [c.name, c]));

  const wrap = document.getElementById('chord-strip-wrap');
  if (!wrap) return;

  if (beatTimes.length === 0) {
    wrap.classList.add('hidden');
    return;
  }

  wrap.classList.remove('hidden');
  renderBeatStrip();
  renderDiagramRow(0);
  updateDiagramsVisibility();
}

export function resetChordPlay() {
  beatTimes = [];
  chordTimeline = [];
  chordLib = {};
  isEditing = false;
  showFingers = true;
  lastBeatIdx = 0;
  pendingPickerBeat = null;
  currentJobId = null;
  closePicker();
  const wrap = document.getElementById('chord-strip-wrap');
  if (wrap) wrap.classList.add('hidden');
}

// ── LRC parse ─────────────────────────────────────────────────────────────────

function parseLrcChords(lrc) {
  if (!lrc) return [];
  const results = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/^\[(\d+):(\d+\.\d+)\](.+)/);
    if (m) {
      const time = parseInt(m[1]) * 60 + parseFloat(m[2]);
      results.push({ time, name: m[3].trim() });
    }
  }
  return results.sort((a, b) => a.time - b.time);
}

function serializeChordTimeline() {
  return chordTimeline.map(({ time, name }) => {
    const min = Math.floor(time / 60).toString().padStart(2, '0');
    const sec = (time % 60).toFixed(2).padStart(5, '0');
    return `[${min}:${sec}]${name}`;
  }).join('\n');
}

// ── Chord at beat ─────────────────────────────────────────────────────────────

function chordAtBeat(beatIdx) {
  if (!beatTimes.length || !chordTimeline.length) return null;
  const t = beatTimes[beatIdx];
  let last = null;
  for (const entry of chordTimeline) {
    if (entry.time <= t + 0.05) last = entry.name;
    else break;
  }
  return last;
}

function currentBeatIdx(currentTimeSec) {
  if (!beatTimes.length) return 0;
  let idx = 0;
  for (let i = 0; i < beatTimes.length; i++) {
    if (beatTimes[i] <= currentTimeSec + 0.02) idx = i;
    else break;
  }
  return idx;
}

// ── Beat strip render ─────────────────────────────────────────────────────────

function renderBeatStrip() {
  const strip = document.getElementById('chord-strip');
  if (!strip) return;
  strip.innerHTML = '';

  for (let i = 0; i < beatTimes.length; i++) {
    const name = chordAtBeat(i);
    const isFirst = i === 0 || name !== chordAtBeat(i - 1);

    const box = document.createElement('div');
    box.className = 'beat-box';
    box.dataset.beat = i;
    if (isFirst && name) box.textContent = name;

    box.addEventListener('click', () => onBeatBoxClick(i));
    strip.appendChild(box);
  }
}

// ── Tick (called from player on each animation frame) ─────────────────────────

export function tickChordPlay(currentTimeSec) {
  if (!beatTimes.length) return;
  const beatIdx = currentBeatIdx(currentTimeSec);
  updateActiveBeat(beatIdx);
  renderDiagramRow(beatIdx);
}

function updateActiveBeat(beatIdx) {
  const strip = document.getElementById('chord-strip');
  if (!strip) return;

  const boxes = strip.querySelectorAll('.beat-box');
  boxes.forEach((box, i) => {
    box.classList.toggle('active', i === beatIdx);
    box.classList.toggle('past', i < beatIdx);
    box.classList.toggle('future', i > beatIdx);
  });

  // Scroll so active box sits just left of center
  strip.scrollLeft = beatIdx * BEAT_BOX_PX - strip.clientWidth * ACTIVE_RATIO;
}

// ── Diagram row ───────────────────────────────────────────────────────────────

function renderDiagramRow(beatIdx) {
  const row = document.getElementById('chord-diagram-row');
  if (!row || !showDiagrams) return;

  // Collect unique chords around current beat
  const seen = new Set();
  const entries = [];
  const half = Math.floor(DIAGRAMS_COUNT / 2);

  // Look backwards and forwards for chord changes
  for (let delta = -half * 2; delta <= half * 2 * 2; delta++) {
    const i = beatIdx + delta;
    if (i < 0 || i >= beatTimes.length) continue;
    const name = chordAtBeat(i);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, beatIdx: i, delta });
    if (entries.length >= DIAGRAMS_COUNT) break;
  }

  row.innerHTML = '';
  for (const entry of entries) {
    const isCurrent = chordAtBeat(beatIdx) === entry.name && entry.beatIdx <= beatIdx;
    const posClass = isCurrent ? 'current' : (entry.delta < 0 ? 'past' : 'upcoming');
    const div = document.createElement('div');
    div.className = `chord-diagram-card ${posClass}`;

    const chordDef = chordLib[entry.name];
    if (chordDef) {
      div.appendChild(renderChordSVG(chordDef, isCurrent ? 'large' : 'medium'));
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'chord-diagram-placeholder';
      placeholder.textContent = '?';
      div.appendChild(placeholder);
    }

    const label = document.createElement('span');
    label.textContent = entry.name;
    div.appendChild(label);

    div.addEventListener('click', () => {
      const t = beatTimes[entry.beatIdx];
      if (t !== undefined) window.seekTo(t);
    });

    row.appendChild(div);
  }

  const currentCard = row.querySelector('.current');
  if (currentCard) currentCard.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

// ── Diagrams toggle ───────────────────────────────────────────────────────────

export function toggleDiagrams() {
  showDiagrams = !showDiagrams;
  updateDiagramsVisibility();
  const btn = document.getElementById('chord-diagrams-btn');
  if (btn) {
    btn.classList.toggle('text-[#22c55e]', showDiagrams);
    btn.classList.toggle('text-[#86efac]', !showDiagrams);
  }
}

function updateDiagramsVisibility() {
  const row = document.getElementById('chord-diagram-row');
  if (row) row.style.display = showDiagrams ? '' : 'none';
}

// ── Tempo control ─────────────────────────────────────────────────────────────

export function setTempoPercent(pct) {
  playbackRate = Math.max(0.5, Math.min(1.5, pct / 100));
  const label = document.getElementById('tempo-label');
  if (label) label.textContent = `${Math.round(playbackRate * 100)}%`;
  if (window.setPlaybackRate) window.setPlaybackRate(playbackRate);
}

export function adjustTempo(delta) {
  setTempoPercent(Math.round(playbackRate * 100) + delta);
}

// ── Editor mode ───────────────────────────────────────────────────────────────

export function enterEditMode() {
  isEditing = true;
  const strip = document.getElementById('chord-strip');
  if (strip) strip.dataset.editing = '1';
  const panel = document.getElementById('chord-edit-panel');
  if (panel) panel.classList.remove('hidden');
  refreshEditList();
}

export function exitEditMode() {
  isEditing = false;
  const strip = document.getElementById('chord-strip');
  if (strip) delete strip.dataset.editing;
  const panel = document.getElementById('chord-edit-panel');
  if (panel) panel.classList.add('hidden');
  closePicker();
  pendingPickerBeat = null;
}

function onBeatBoxClick(beatIdx) {
  if (!isEditing) {
    if (beatTimes[beatIdx] !== undefined) window.seekTo(beatTimes[beatIdx]);
    return;
  }
  pendingPickerBeat = beatIdx;
  openPicker(beatIdx);
}

// ── Chord picker (edit mode popup) ───────────────────────────────────────────

function openPicker(beatIdx) {
  closePicker();
  const existing = document.getElementById('chord-picker-popup');
  if (existing) existing.remove();

  const strip = document.getElementById('chord-strip');
  if (!strip) return;

  const popup = document.createElement('div');
  popup.id = 'chord-picker-popup';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Chord name…';
  input.className = 'chord-picker-input';
  popup.appendChild(input);

  const chips = document.createElement('div');
  chips.className = 'chord-picker-chips';

  const renderChips = (filter) => {
    chips.innerHTML = '';
    const names = Object.keys(chordLib).filter(n => !filter || n.toLowerCase().startsWith(filter.toLowerCase()));
    names.slice(0, 20).forEach(name => {
      const chip = document.createElement('button');
      chip.className = 'chord-picker-chip';
      chip.textContent = name;
      chip.addEventListener('click', () => placeChordAtBeat(beatIdx, name));
      chips.appendChild(chip);
    });
  };

  renderChips('');
  input.addEventListener('input', () => renderChips(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && input.value.trim()) placeChordAtBeat(beatIdx, input.value.trim());
  });

  popup.appendChild(chips);

  const cancel = document.createElement('button');
  cancel.className = 'chord-picker-cancel';
  cancel.textContent = '✕';
  cancel.addEventListener('click', closePicker);
  popup.appendChild(cancel);

  document.getElementById('chord-strip-wrap').appendChild(popup);
  input.focus();
}

function closePicker() {
  const popup = document.getElementById('chord-picker-popup');
  if (popup) popup.remove();
}

function placeChordAtBeat(beatIdx, chordName) {
  const t = beatTimes[beatIdx];
  if (t === undefined) return;

  // Remove existing entry at the exact same beat time
  chordTimeline = chordTimeline.filter(e => Math.abs(e.time - t) > 0.01);
  chordTimeline.push({ time: t, name: chordName });
  chordTimeline.sort((a, b) => a.time - b.time);

  closePicker();
  pendingPickerBeat = null;
  saveChordTimeline();
  renderBeatStrip();
  refreshEditList();
}

export function removeChordAtBeat(beatIdx) {
  const t = beatTimes[beatIdx];
  if (t === undefined) return;
  // Remove the chord whose start beat matches
  const name = chordAtBeat(beatIdx);
  if (!name) return;
  // Find and remove the timeline entry whose time matches the first beat of this chord
  let entryTime = null;
  for (let i = beatIdx; i >= 0; i--) {
    if (chordAtBeat(i) !== name) {
      entryTime = beatTimes[i + 1];
      break;
    }
    if (i === 0) entryTime = beatTimes[0];
  }
  if (entryTime !== undefined) {
    chordTimeline = chordTimeline.filter(e => Math.abs(e.time - entryTime) > 0.01);
    saveChordTimeline();
    renderBeatStrip();
    refreshEditList();
  }
}

export function clearAllChords() {
  chordTimeline = [];
  saveChordTimeline();
  renderBeatStrip();
  refreshEditList();
}

async function saveChordTimeline() {
  if (!currentJobId) return;
  await fetch(`/api/jobs/${currentJobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ song_chord_data: serializeChordTimeline() }),
  });
}

// ── Edit panel list ───────────────────────────────────────────────────────────

export function refreshEditList() {
  const list = document.getElementById('chord-edit-list');
  if (!list) return;
  list.innerHTML = '';

  chordTimeline.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'chord-edit-row';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chord-edit-time';
    const min = Math.floor(entry.time / 60).toString().padStart(2, '0');
    const sec = (entry.time % 60).toFixed(2).padStart(5, '0');
    timeSpan.textContent = `${min}:${sec}`;
    timeSpan.addEventListener('click', () => window.seekTo(entry.time));

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chord-edit-name';
    nameSpan.textContent = entry.name;

    const del = document.createElement('button');
    del.className = 'chord-edit-del';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      chordTimeline.splice(idx, 1);
      saveChordTimeline();
      renderBeatStrip();
      refreshEditList();
    });

    row.appendChild(timeSpan);
    row.appendChild(nameSpan);
    row.appendChild(del);
    list.appendChild(row);
  });
}

// ── Refresh chord library in picker when library changes ─────────────────────

export async function refreshChordLib() {
  const lib = await fetchChords();
  chordLib = Object.fromEntries(lib.map(c => [c.name, c]));
}
