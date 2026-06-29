// Chord beat-grid strip: rendering, playback sync, diagram row, tempo, editor

import { renderChordSVG, fetchChords } from './chord-lib.js';

const BEAT_BOX_PX = 52;       // width of each beat box in pixels
const ACTIVE_RATIO = 0.4;  // active beat sits at 40% from the left (just left of center)
const DIAGRAMS_COUNT = 5;     // number of diagrams shown in the diagram row (2 past + current + 2 upcoming)
const BEATS_PER_BAR = 4;

// ── State ─────────────────────────────────────────────────────────────────────

let beatTimes = [];            // array of beat timestamps in seconds (with offset applied)
let rawBeatTimes = [];         // original beat times from DB before offset
let beatOffset = 0;            // seconds added to all beat times (phase alignment)
let barOffset = 0;             // which beat index (0-3) is beat 1 of bar 1
let currentBpm = 0;            // current BPM (may differ from detected after fine-tuning)
let songDuration = 0;          // song length in seconds (used to regenerate beat grid)
let chordTimeline = [];        // [{beatIndex, name}] sorted by beatIndex
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
  rawBeatTimes = stemData.beat_times ? JSON.parse(stemData.beat_times) : [];
  beatOffset = stemData.beat_offset ?? 0;
  barOffset = stemData.bar_offset ?? 0;
  currentBpm = stemData.bpm ?? 0;
  songDuration = stemData.duration_sec ?? 0;
  beatTimes = rawBeatTimes.map(t => t + beatOffset);

  const rawData = stemData.song_chord_data || '';
  chordTimeline = parseChordData(rawData, beatTimes);

  // Auto-migrate: if the stored data was in legacy LRC format, save it in the
  // new beat-index format immediately so future loads are clean.
  if (rawData.trim().startsWith('[') && chordTimeline.length > 0) {
    saveChordTimeline();
  }

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
  rawBeatTimes = [];
  beatOffset = 0;
  barOffset = 0;
  currentBpm = 0;
  songDuration = 0;
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

// ── Chord data parse / serialize ──────────────────────────────────────────────

// Accepts both the new "beatIndex:name" format and legacy LRC "[MM:SS.ss]name".
// LRC entries are snapped to the nearest beat index using the provided times array.
function parseChordData(data, timesArr) {
  if (!data || !data.trim()) return [];

  // Legacy LRC format detection
  if (data.trim().startsWith('[')) {
    const lrcEntries = [];
    for (const line of data.split('\n')) {
      const m = line.match(/^\[(\d+):(\d+\.\d+)\](.+)/);
      if (m) {
        const time = parseInt(m[1]) * 60 + parseFloat(m[2]);
        lrcEntries.push({ time, name: m[3].trim() });
      }
    }
    // Snap each timestamp to the nearest beat index
    return lrcEntries.map(({ time, name }) => {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < timesArr.length; i++) {
        const dist = Math.abs(timesArr[i] - time);
        if (dist < nearestDist) { nearestDist = dist; nearestIdx = i; }
        if (timesArr[i] > time + 2) break;
      }
      return { beatIndex: nearestIdx, name };
    }).sort((a, b) => a.beatIndex - b.beatIndex);
  }

  // New format: "beatIndex:chordName" per line
  const result = [];
  for (const line of data.split('\n')) {
    const m = line.match(/^(\d+):(.+)/);
    if (m) result.push({ beatIndex: parseInt(m[1]), name: m[2].trim() });
  }
  return result.sort((a, b) => a.beatIndex - b.beatIndex);
}

function serializeChordTimeline() {
  return chordTimeline.map(({ beatIndex, name }) => `${beatIndex}:${name}`).join('\n');
}

// ── Chord at beat ─────────────────────────────────────────────────────────────

// Returns the chord name active at beatIdx — the most recent entry whose
// beatIndex is <= beatIdx. Pure index arithmetic, no time comparison.
function chordAtBeat(beatIdx) {
  if (!chordTimeline.length) return null;
  let last = null;
  for (const entry of chordTimeline) {
    if (entry.beatIndex <= beatIdx) last = entry.name;
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
    const posInBar = (i - barOffset + BEATS_PER_BAR * 1000) % BEATS_PER_BAR;

    const box = document.createElement('div');
    box.className = 'beat-box' + (posInBar === 0 ? ' bar-start' : '');
    box.dataset.beat = i;

    // Use a child span so chord name and beat-num never concatenate
    if (isFirst && name) {
      const nameSpan = document.createElement('span');
      nameSpan.className = 'beat-chord';
      nameSpan.textContent = name;
      box.appendChild(nameSpan);
    }

    const dot = document.createElement('span');
    dot.className = 'beat-num';
    dot.textContent = posInBar + 1;
    box.appendChild(dot);

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

// ── Bar offset ────────────────────────────────────────────────────────────────

export function setBarOffset(n) {
  barOffset = ((n % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
  renderBeatStrip();
  _syncBarOffsetUI();
  if (currentJobId) {
    fetch(`/api/jobs/${currentJobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bar_offset: barOffset }),
    });
  }
}

function _syncBarOffsetUI() {
  document.querySelectorAll('.bar-offset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.offset) === barOffset);
  });
}

// ── Beat offset nudge ─────────────────────────────────────────────────────────

export function nudgeBeatOffsetByBeat(beats) {
  if (!rawBeatTimes.length) return;
  const interval = rawBeatTimes.length > 1 ? rawBeatTimes[1] - rawBeatTimes[0] : 0;
  if (interval > 0) nudgeBeatOffset(beats * interval);
}

export function nudgeBeatOffset(deltaSec) {
  if (!rawBeatTimes.length || !currentJobId) return;
  beatOffset = Math.round((beatOffset + deltaSec) * 1000) / 1000;
  beatTimes = rawBeatTimes.map(t => t + beatOffset);
  renderBeatStrip();
  // Chords stay at their beat indices — only the timing of those beats changes
  fetch(`/api/jobs/${currentJobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ beat_offset: beatOffset }),
  });
  const label = document.getElementById('beat-offset-label');
  if (label) label.textContent = (beatOffset >= 0 ? '+' : '') + beatOffset.toFixed(3) + 's';
}

// ── BPM fine-tune ─────────────────────────────────────────────────────────────

export function adjustBpm(delta) {
  if (!currentJobId || rawBeatTimes.length < 2 || currentBpm <= 0) return;
  currentBpm = Math.round((currentBpm + delta) * 10) / 10;
  currentBpm = Math.max(40, Math.min(240, currentBpm));

  // Regenerate beat grid from the same phase, new interval
  const phase = rawBeatTimes[0];
  const interval = 60.0 / currentBpm;
  const newTimes = [];
  const end = songDuration > 0 ? songDuration : rawBeatTimes[rawBeatTimes.length - 1];
  for (let t = phase; t <= end + interval * 0.5; t += interval) {
    newTimes.push(Math.round(t * 10000) / 10000);
  }
  rawBeatTimes = newTimes;
  beatTimes = rawBeatTimes.map(t => t + beatOffset);
  renderBeatStrip();
  refreshEditList();

  // Update BPM labels
  const fineLabel = document.getElementById('bpm-fine-label');
  if (fineLabel) fineLabel.textContent = currentBpm.toFixed(1);
  const badge = document.getElementById('player-bpm');
  if (badge) badge.textContent = `${currentBpm.toFixed(1)} BPM`;
  const detectLabel = document.getElementById('chord-detect-label');
  if (detectLabel) detectLabel.textContent = currentBpm.toFixed(1);

  // Persist new BPM and recalculated beat_times
  fetch(`/api/jobs/${currentJobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bpm: currentBpm, beat_times: JSON.stringify(rawBeatTimes) }),
  });
}

// ── Editor mode ───────────────────────────────────────────────────────────────

export function enterEditMode() {
  isEditing = true;
  const strip = document.getElementById('chord-strip');
  if (strip) strip.dataset.editing = '1';
  const panel = document.getElementById('chord-edit-panel');
  if (panel) panel.classList.remove('hidden');
  const offsetLabel = document.getElementById('beat-offset-label');
  if (offsetLabel) offsetLabel.textContent = (beatOffset >= 0 ? '+' : '') + beatOffset.toFixed(3) + 's';
  const bpmLabel = document.getElementById('bpm-fine-label');
  if (bpmLabel) bpmLabel.textContent = currentBpm > 0 ? currentBpm.toFixed(1) : '—';
  _syncBarOffsetUI();
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
  // Remove any existing chord starting at this exact beat index
  chordTimeline = chordTimeline.filter(e => e.beatIndex !== beatIdx);
  chordTimeline.push({ beatIndex: beatIdx, name: chordName });
  chordTimeline.sort((a, b) => a.beatIndex - b.beatIndex);

  closePicker();
  pendingPickerBeat = null;
  saveChordTimeline();
  renderBeatStrip();
  refreshEditList();
}

export function removeChordAtBeat(beatIdx) {
  // Find the timeline entry that covers beatIdx (last entry at or before it)
  let target = null;
  for (const entry of chordTimeline) {
    if (entry.beatIndex <= beatIdx) target = entry;
    else break;
  }
  if (!target) return;
  chordTimeline = chordTimeline.filter(e => e !== target);
  saveChordTimeline();
  renderBeatStrip();
  refreshEditList();
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
    const t = beatTimes[entry.beatIndex];
    if (t !== undefined) {
      const min = Math.floor(t / 60).toString().padStart(2, '0');
      const sec = (t % 60).toFixed(2).padStart(5, '0');
      timeSpan.textContent = `${min}:${sec}`;
      timeSpan.addEventListener('click', () => window.seekTo(t));
    } else {
      timeSpan.textContent = `#${entry.beatIndex}`;
    }

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

// ── Bulk import ───────────────────────────────────────────────────────────────

export function openImportModal() {
  const modal = document.getElementById('chord-import-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const ta = document.getElementById('chord-import-text');
  if (ta) ta.focus();
}

function closeImportModal() {
  const modal = document.getElementById('chord-import-modal');
  if (modal) modal.classList.add('hidden');
}

function applyBulkImport() {
  const ta = document.getElementById('chord-import-text');
  if (!ta) return;

  const tokens = ta.value.trim().split(/[\s\n]+/).filter(Boolean);

  let beatIdx = 0;
  let prevChord = null;
  const entries = [];

  for (const tok of tokens) {
    if (tok === '|') {
      // Snap forward to the next bar-start beat (posInBar === 0)
      while (beatIdx < beatTimes.length) {
        const pos = (beatIdx - barOffset + BEATS_PER_BAR * 1000) % BEATS_PER_BAR;
        if (pos === 0) break;
        beatIdx++;
      }
      continue;
    }

    if (beatIdx >= beatTimes.length) break;

    if (tok === '.') {
      // hold current chord, advance one beat
    } else if (tok === '-') {
      prevChord = null;
    } else if (tok !== prevChord) {
      entries.push({ beatIndex: beatIdx, name: tok });
      prevChord = tok;
    }

    beatIdx++;
  }

  // Replace chords up to the last imported beat index, keep everything after
  const lastImportedBeat = beatIdx - 1;
  chordTimeline = chordTimeline.filter(e => e.beatIndex > lastImportedBeat);
  chordTimeline.push(...entries);
  chordTimeline.sort((a, b) => a.beatIndex - b.beatIndex);

  closeImportModal();
  saveChordTimeline();
  renderBeatStrip();
  refreshEditList();
}

// Wire up import modal buttons (called once after DOM ready)
export function initImportModal() {
  document.getElementById('chord-edit-import')?.addEventListener('click', openImportModal);
  document.getElementById('chord-import-close')?.addEventListener('click', closeImportModal);
  document.getElementById('chord-import-cancel')?.addEventListener('click', closeImportModal);
  document.getElementById('chord-import-apply')?.addEventListener('click', applyBulkImport);
}

// ── Refresh chord library in picker when library changes ─────────────────────

export async function refreshChordLib() {
  const lib = await fetchChords();
  chordLib = Object.fromEntries(lib.map(c => [c.name, c]));
}
