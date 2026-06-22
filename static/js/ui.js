'use strict';

import {
  resetPlayer, loadStems, togglePlay, seekTo, touchSeek, seekRelative, doSeek,
  adjustVolume, toggleMute, toggleFullscreen, toggleStem, soloStem, setPlaybackRate,
} from './player.js';
import {
  resetLyrics, initLyrics, cycleLyricsMode, setSeekFn,
} from './chords.js';
import {
  initChordPlay, resetChordPlay, tickChordPlay,
  toggleDiagrams, adjustTempo,
  enterEditMode, exitEditMode,
  clearAllChords, refreshEditList, refreshChordLib,
} from './chord-play.js';
import {
  fetchChords, createChord, updateChord, deleteChord, renderChordSVG,
} from './chord-lib.js';

// Wire lyric seek clicks through to the player
setSeekFn(doSeek);

// Expose chord tick to player.js via window
window._tickChordPlay = tickChordPlay;
window.setPlaybackRate = setPlaybackRate;

const STATUS_COLOR = { done: '#22c55e', processing: '#fbbf24', pending: '#94a3b8', error: '#f87171' };
const STATUS_LABEL = { done: 'Ready', processing: 'Processing…', pending: 'Queued', error: 'Error' };

const $ = id => document.getElementById(id);
const esc = s => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) { const t = await r.text(); throw new Error(t || `HTTP ${r.status}`); }
  return r.json();
}

// ── Views ─────────────────────────────────────────────────────────────────────

function showLibrary() {
  $('library-view').style.display        = '';
  $('player-view').style.display         = 'none';
  $('chord-library-view').style.display  = 'none';
}

function showPlayer() {
  $('library-view').style.display        = 'none';
  $('player-view').style.display         = '';
  $('chord-library-view').style.display  = 'none';
}

function showChordLibrary() {
  $('library-view').style.display        = 'none';
  $('player-view').style.display         = 'none';
  $('chord-library-view').style.display  = '';
  refreshChordLibraryView();
}

// ── Library ───────────────────────────────────────────────────────────────────

function renderCard(job) {
  const col = STATUS_COLOR[job.status] || '#94a3b8';
  const lbl = STATUS_LABEL[job.status] || job.status;

  const el = job.status === 'done'
    ? document.createElement('button')
    : document.createElement('div');

  el.className = 'bg-[#172017] rounded-2xl p-3 border border-[#1e2e1e] w-full text-left select-none';
  if (job.status === 'done') el.style.cursor = 'pointer';
  el.style.borderLeftColor = col;
  el.style.borderLeftWidth = '3px';
  el.style.touchAction     = 'manipulation';

  el.innerHTML = `
    <div class="flex items-center justify-between mb-1.5">
      <div class="w-2 h-2 rounded-full flex-shrink-0" style="background:${col}"></div>
      <div class="flex items-center gap-2">
        <span class="text-xs" style="color:${col}">${lbl}</span>
        <button class="delete-btn p-0.5 text-[#86efac] opacity-30 hover:opacity-80 hover:text-[#f87171] transition-opacity active:scale-95" title="Delete song">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
        </button>
      </div>
    </div>
    <p class="font-semibold text-sm text-[#f0fdf4] leading-snug mb-0.5 line-clamp-2">${esc(job.title || job.filename)}</p>
    ${job.artist ? `<p class="text-xs text-[#86efac] truncate opacity-70">${esc(job.artist)}</p>` : ''}
    ${job.status === 'processing' ? `
      <div class="mt-2">
        <div class="h-1 bg-[#1e2e1e] rounded-full overflow-hidden">
          <div class="h-full bg-[#fbbf24] rounded-full transition-all" style="width:${job.progress || 0}%"></div>
        </div>
        <p class="text-xs text-[#86efac] mt-1 opacity-60 truncate">${esc(job.progress_phase || 'Processing…')}</p>
      </div>` : ''}
    ${job.status === 'error' ? `<p class="text-xs text-[#f87171] mt-1 truncate">${esc(job.error_msg || 'Failed')}</p>` : ''}
  `;

  if (job.status === 'done') {
    el.addEventListener('click', () => openPlayer(job));
  }

  el.querySelector('.delete-btn').addEventListener('click', e => {
    e.stopPropagation();
    confirmDelete(job);
  });

  let lpX = 0, lpY = 0, lpTimer = null;
  el.addEventListener('pointerdown', e => {
    lpX = e.clientX; lpY = e.clientY;
    lpTimer = setTimeout(() => confirmDelete(job), 800);
  });
  el.addEventListener('pointermove', e => {
    if (Math.hypot(e.clientX - lpX, e.clientY - lpY) > 8) clearTimeout(lpTimer);
  });
  el.addEventListener('pointerup',     () => clearTimeout(lpTimer));
  el.addEventListener('pointercancel', () => clearTimeout(lpTimer));

  return el;
}

async function refreshLibrary() {
  try {
    const jobs = await api('/api/jobs');
    const grid  = $('song-grid');
    const empty = $('empty-state');
    grid.innerHTML = '';
    if (!jobs.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    jobs.forEach(j => grid.appendChild(renderCard(j)));
    updateBanner(jobs);
  } catch (e) { console.error('library refresh:', e); }
}

function updateBanner(jobs) {
  const b    = $('worker-banner');
  const proc = jobs.filter(j => j.status === 'processing');
  const pend = jobs.filter(j => j.status === 'pending');
  if (proc.length) {
    b.className   = 'px-4 py-2 text-xs text-center border-b border-[#1e2e1e] text-[#fbbf24] bg-[#111811]';
    b.textContent = `Processing: ${proc[0].title || 'Song'} — ${proc[0].progress || 0}%`;
    b.classList.remove('hidden');
  } else if (pend.length) {
    b.className   = 'px-4 py-2 text-xs text-center border-b border-[#1e2e1e] text-[#86efac] bg-[#111811]';
    b.textContent = `${pend.length} song${pend.length > 1 ? 's' : ''} queued — start worker.py to process`;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

async function confirmDelete(job) {
  if (!confirm(`Delete "${job.title || job.filename}"? This cannot be undone.`)) return;
  await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
  refreshLibrary();
}

// ── Player ────────────────────────────────────────────────────────────────────

async function openPlayer(job) {
  resetPlayer();
  resetLyrics();

  $('player-title').textContent  = job.title || job.filename || 'Song';
  $('player-artist').textContent = job.artist || '';
  $('stem-grid').classList.add('hidden');
  $('stem-loading').classList.remove('hidden');
  $('stem-loading-text').textContent = 'Loading stems…';
  $('progress-fill').style.width = '0%';
  $('time-current').textContent  = '0:00';
  $('time-total').textContent    = '0:00';
  showPlayer();

  try {
    const data = await api(`/api/stems/${job.id}`);
    initLyrics(data.chord_data, data.chord_source);
    await initChordPlay(job.id, data);
    applyChordUIState(job.id, data);
    await loadStems(job.id, data.stems || []);
  } catch (e) {
    $('stem-loading-text').textContent = 'Error: ' + e.message;
  }
}

function closePlayer() {
  resetPlayer();
  resetLyrics();
  resetChordPlay();
  exitEditMode();
  showLibrary();
}

// ── Add Song ──────────────────────────────────────────────────────────────────

let activeTab    = 'upload';
let selectedFile = null;
let _ytMetaTimer = null;

function openAddSheet() {
  selectedFile           = null;
  $('meta-title').value  = '';
  $('meta-artist').value = '';
  $('yt-url').value      = '';
  $('file-chosen').classList.add('hidden');
  $('add-error').classList.add('hidden');
  $('yt-meta-status').classList.add('hidden');
  clearTimeout(_ytMetaTimer);
  switchTab('upload');
  $('sheet').classList.add('open');
  $('sheet-backdrop').classList.add('open');
}

function closeSheet() {
  $('sheet').classList.remove('open');
  $('sheet-backdrop').classList.remove('open');
}

function switchTab(t) {
  activeTab = t;
  $('panel-upload').classList.toggle('hidden', t !== 'upload');
  $('panel-youtube').classList.toggle('hidden', t !== 'youtube');
  const active   = 'flex-1 py-2.5 rounded-xl text-sm font-semibold bg-[#22c55e] text-[#0a0f0a]';
  const inactive = 'flex-1 py-2.5 rounded-xl text-sm font-semibold bg-[#172017] text-[#86efac] border border-[#1e2e1e]';
  $('tab-upload').className  = t === 'upload'  ? active : inactive;
  $('tab-youtube').className = t === 'youtube' ? active : inactive;
}

function handleDrop(e) {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
}

function handleFileSelect(e) {
  const f = e.target.files[0];
  if (f) setFile(f);
}

function setFile(f) {
  selectedFile = f;
  $('file-chosen').textContent = f.name;
  $('file-chosen').classList.remove('hidden');
  if (!$('meta-title').value) $('meta-title').value = f.name.replace(/\.[^/.]+$/, '');
}

async function onYtUrlInput() {
  const url = $('yt-url').value.trim();
  const st  = $('yt-meta-status');
  clearTimeout(_ytMetaTimer);
  if (!url.match(/youtube|youtu\.be/i)) { st.classList.add('hidden'); return; }
  st.textContent = 'Fetching info…';
  st.classList.remove('hidden');
  _ytMetaTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/youtube/metadata?url=${encodeURIComponent(url)}`);
      if (!$('meta-title').value  && data.title)  $('meta-title').value  = data.title;
      if (!$('meta-artist').value && data.artist) $('meta-artist').value = data.artist;
      st.textContent = data.title ? '✓ Title fetched' : 'No title found';
    } catch (e) {
      st.textContent = 'Could not fetch info';
    }
    setTimeout(() => st.classList.add('hidden'), 2500);
  }, 700);
}

async function submitSong() {
  const err = $('add-error');
  const btn = $('add-btn');
  err.classList.add('hidden');
  btn.disabled    = true;
  btn.textContent = 'Adding…';
  try {
    const fd = new FormData();
    if (activeTab === 'upload') {
      if (!selectedFile) throw new Error('Please choose a file');
      fd.append('file',   selectedFile);
      fd.append('model',  'htdemucs_6s');
      fd.append('shifts', '0');
      fd.append('title',  $('meta-title').value);
      fd.append('artist', $('meta-artist').value);
      await api('/api/upload', { method: 'POST', body: fd });
    } else {
      const url = $('yt-url').value.trim();
      if (!url) throw new Error('Please enter a YouTube URL');
      fd.append('url',    url);
      fd.append('title',  $('meta-title').value);
      fd.append('artist', $('meta-artist').value);
      await api('/api/youtube', { method: 'POST', body: fd });
    }
    closeSheet();
    refreshLibrary();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Add to Queue';
  }
}

// ── Chord UI state helper ─────────────────────────────────────────────────────

let _currentPlayerJobId = null;

function applyChordUIState(jobId, data) {
  _currentPlayerJobId = jobId;
  const hasBeats = !!(data.beat_times);
  $('chord-tabs').classList.toggle('hidden', !hasBeats);
  $('chord-diagrams-btn').classList.toggle('hidden', !hasBeats);
  if (hasBeats) {
    $('chord-diagrams-btn').classList.add('text-[#22c55e]');
    $('chord-diagrams-btn').classList.remove('text-[#86efac]');
  }
  $('tempo-control').classList.toggle('hidden', !hasBeats);
  $('chord-detect-btn').classList.toggle('hidden', hasBeats);
  if (hasBeats) setChordTab('diagrams');
}

async function detectBPM() {
  if (!_currentPlayerJobId) return;
  const btn = $('chord-detect-btn');
  const label = $('chord-detect-label');
  btn.disabled = true;
  label.textContent = '…';
  try {
    const data = await api(`/api/jobs/${_currentPlayerJobId}/detect-bpm`, { method: 'POST' });
    // Reload stems data to get fresh beat_times
    const stemData = await api(`/api/stems/${_currentPlayerJobId}`);
    await initChordPlay(_currentPlayerJobId, stemData);
    applyChordUIState(_currentPlayerJobId, stemData);
    label.textContent = `${Math.round(data.bpm)}`;
  } catch (e) {
    label.textContent = 'ERR';
    setTimeout(() => { label.textContent = 'BPM'; btn.disabled = false; }, 2000);
    return;
  }
  btn.disabled = false;
  label.textContent = 'BPM';
}

// ── Chord tabs (Diagrams / Edit) ──────────────────────────────────────────────

function setChordTab(tab) {
  const diagrams = tab === 'diagrams';
  $('chord-tab-diagrams').classList.toggle('active', diagrams);
  $('chord-tab-edit').classList.toggle('active', !diagrams);
  if (diagrams) {
    exitEditMode();
  } else {
    enterEditMode();
    refreshEditPickerPanel();
  }
}

async function refreshEditPickerPanel() {
  const picker = $('chord-edit-picker');
  const searchInput = $('chord-edit-search');
  if (!picker) return;

  const chords = await fetchChords();
  const renderPicker = (filter) => {
    picker.innerHTML = '';
    chords
      .filter(c => !filter || c.name.toLowerCase().startsWith(filter.toLowerCase()))
      .forEach(c => {
        const chip = document.createElement('button');
        chip.className = 'chord-picker-chip text-xs px-2 py-1 rounded-lg bg-[#172017] border border-[#1e2e1e] text-[#f0fdf4] hover:border-[#22c55e] transition-all';
        chip.textContent = c.name;
        chip.addEventListener('click', () => {
          // Close any open picker popup and let chord-play.js handle insertion
          // via the pendingPickerBeat approach — here we just surface the name
          // for the strip picker by broadcasting a custom event
          document.dispatchEvent(new CustomEvent('chord-pick', { detail: c.name }));
        });
        picker.appendChild(chip);
      });
  };

  renderPicker('');
  if (searchInput) {
    searchInput.oninput = () => renderPicker(searchInput.value);
  }
}

// ── Chord Library View ────────────────────────────────────────────────────────

async function refreshChordLibraryView() {
  const grid = $('chord-lib-grid');
  const empty = $('chord-lib-empty');
  if (!grid) return;
  grid.innerHTML = '';

  const chords = await fetchChords();
  if (!chords.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  chords.forEach(chord => {
    const card = document.createElement('button');
    card.className = 'flex flex-col items-center gap-1 p-2 rounded-2xl bg-[#172017] border border-[#1e2e1e] hover:border-[#22c55e] transition-all';

    const svg = renderChordSVG(chord, 'small');
    card.appendChild(svg);

    const label = document.createElement('span');
    label.className = 'text-xs text-[#f0fdf4] font-semibold';
    label.textContent = chord.name;
    card.appendChild(label);

    card.addEventListener('click', () => openChordEditor(chord));
    grid.appendChild(card);
  });
}

// ── Chord Editor ──────────────────────────────────────────────────────────────

let _editingChord = null;  // null = new chord
// Fretboard state: 6 strings, each value -1=muted, 0=open, 1-N=fret
let _edFrets   = [-1, -1, -1, -1, -1, -1];
let _edFingers = [0, 0, 0, 0, 0, 0];

function openChordEditor(chord = null) {
  _editingChord = chord;
  _edFrets   = chord ? JSON.parse(chord.frets) : [-1, -1, -1, -1, -1, -1];
  _edFingers = chord ? JSON.parse(chord.fingers) : [0, 0, 0, 0, 0, 0];

  $('chord-editor-title').textContent = chord ? 'Edit Chord' : 'New Chord';
  $('chord-editor-name').value = chord?.name || '';
  $('chord-editor-delete').classList.toggle('hidden', !chord);

  const barre = chord?.barre ? JSON.parse(chord.barre) : null;
  $('chord-editor-barre-on').checked = !!barre;
  $('chord-editor-barre-opts').classList.toggle('hidden', !barre);
  if (barre) {
    $('chord-editor-barre-fret').value = barre.fret;
    $('chord-editor-barre-from').value = barre.from;
    $('chord-editor-barre-to').value   = barre.to;
  }

  renderEditorFretboard();
  renderEditorPreview();

  $('chord-editor-panel').classList.remove('hidden');
  $('chord-editor-backdrop').classList.remove('hidden');
}

function closeChordEditor() {
  $('chord-editor-panel').classList.add('hidden');
  $('chord-editor-backdrop').classList.add('hidden');
  _editingChord = null;
}

function getBarreFromEditor() {
  if (!$('chord-editor-barre-on').checked) return null;
  return {
    fret: parseInt($('chord-editor-barre-fret').value) || 1,
    from: parseInt($('chord-editor-barre-from').value) || 0,
    to:   parseInt($('chord-editor-barre-to').value)   || 5,
  };
}

function renderEditorStringTops() {
  const container = $('chord-editor-string-tops');
  if (!container) return;
  container.innerHTML = '';
  const labels = ['E', 'A', 'D', 'G', 'B', 'e'];
  for (let s = 0; s < 6; s++) {
    const btn = document.createElement('button');
    const f = _edFrets[s];
    btn.className = 'flex-1 text-center text-xs py-1 rounded transition-colors';
    btn.textContent = f === -1 ? '✕' : '○';
    btn.style.color = f === -1 ? '#f87171' : '#86efac';
    btn.title = labels[s];
    btn.addEventListener('click', () => {
      _edFrets[s] = f === -1 ? 0 : -1;
      if (_edFrets[s] === -1) _edFingers[s] = 0;
      renderEditorStringTops();
      renderEditorFretboard();
      renderEditorPreview();
    });
    container.appendChild(btn);
  }
}

function renderEditorFretboard() {
  const board = $('chord-editor-fretboard');
  if (!board) return;
  board.innerHTML = '';

  const strings = 6, frets = 5;
  const VW = 300, VH = 200;
  const dotR = 13;
  const padL = dotR + 2, padR = dotR + 2;
  const topPad = 40;   // toggle symbol area above nut
  const nutH = 6;
  const bottomPad = 10;
  const gridW = VW - padL - padR;
  const sGap = gridW / (strings - 1);
  const fretAreaH = VH - topPad - nutH - bottomPad;
  const fGap = fretAreaH / frets;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VW} ${VH}`);
  svg.style.width = '100%';
  svg.style.display = 'block';
  svg.style.touchAction = 'none';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // String toggle symbols (○ / ✕) above nut
  for (let s = 0; s < strings; s++) {
    const cx = padL + s * sGap;
    const f = _edFrets[s];
    el('text', {
      x: cx, y: topPad * 0.48,
      'font-size': 15,
      fill: f === -1 ? '#f87171' : '#86efac',
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'font-family': 'monospace',
    }, svg).textContent = f === -1 ? '✕' : '○';
  }

  // Nut bar
  el('rect', {
    x: padL, y: topPad,
    width: gridW, height: nutH,
    fill: '#86efac',
  }, svg);

  // Fret lines
  for (let f = 0; f <= frets; f++) {
    const y = topPad + nutH + f * fGap;
    el('line', {
      x1: padL, y1: y, x2: padL + gridW, y2: y,
      stroke: '#2d4a2d', 'stroke-width': 1,
    }, svg);
  }

  // String lines
  for (let s = 0; s < strings; s++) {
    const x = padL + s * sGap;
    el('line', {
      x1: x, y1: topPad + nutH,
      x2: x, y2: topPad + nutH + frets * fGap,
      stroke: '#4ade80', 'stroke-width': 1,
    }, svg);
  }

  // Finger dots
  for (let s = 0; s < strings; s++) {
    const f = _edFrets[s];
    if (f <= 0) continue;
    const cx = padL + s * sGap;
    const cy = topPad + nutH + (f - 1) * fGap + fGap * 0.5;
    el('circle', { cx, cy, r: dotR, fill: '#22c55e' }, svg);
    if (_edFingers[s]) {
      el('text', {
        x: cx, y: cy,
        'font-size': dotR * 1.1,
        fill: '#0a0f0a',
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-weight': 'bold',
        'font-family': 'monospace',
      }, svg).textContent = _edFingers[s];
    }
  }

  // Tap / click handler
  svg.addEventListener('pointerdown', e => {
    const rect = svg.getBoundingClientRect();
    const scaleX = VW / rect.width;
    const scaleY = VH / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    let s = Math.round((x - padL) / sGap);
    s = Math.max(0, Math.min(strings - 1, s));

    if (y < topPad) {
      // Toggle symbol area → cycle open ↔ muted
      _edFrets[s] = _edFrets[s] === -1 ? 0 : -1;
      if (_edFrets[s] === -1) _edFingers[s] = 0;
    } else {
      const fretFloat = (y - topPad - nutH) / fGap;
      let f = Math.floor(fretFloat) + 1;
      f = Math.max(1, Math.min(frets, f));

      if (_edFrets[s] === f) {
        // Tap existing dot → cycle finger number 1-4, then remove
        if (_edFingers[s] >= 4) {
          _edFrets[s] = 0;
          _edFingers[s] = 0;
        } else {
          _edFingers[s] = _edFingers[s] + 1;
        }
      } else {
        _edFrets[s] = f;
        _edFingers[s] = 0;
      }
    }

    renderEditorFretboard();
    renderEditorPreview();
  });

  board.appendChild(svg);
}

function renderEditorPreview() {
  const preview = $('chord-editor-preview');
  if (!preview) return;
  preview.innerHTML = '';
  const barre = getBarreFromEditor();
  const chord = {
    name: $('chord-editor-name')?.value || '',
    frets:   JSON.stringify(_edFrets),
    fingers: JSON.stringify(_edFingers),
    barre:   barre ? JSON.stringify(barre) : null,
  };
  preview.appendChild(renderChordSVG(chord, 'large'));
}

async function saveChordEditor() {
  const name = $('chord-editor-name').value.trim();
  if (!name) { alert('Please enter a chord name'); return; }
  const barre = getBarreFromEditor();
  const payload = {
    name,
    frets:   JSON.stringify(_edFrets),
    fingers: JSON.stringify(_edFingers),
    barre:   barre ? JSON.stringify(barre) : null,
  };
  if (_editingChord) {
    await updateChord(_editingChord.id, payload);
  } else {
    await createChord(payload);
  }
  closeChordEditor();
  refreshChordLibraryView();
  await refreshChordLib();
}

async function deleteChordFromEditor() {
  if (!_editingChord) return;
  if (!confirm(`Delete chord "${_editingChord.name}"?`)) return;
  await deleteChord(_editingChord.id);
  closeChordEditor();
  refreshChordLibraryView();
  await refreshChordLib();
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function openSettings() {
  $('settings-panel').classList.remove('hidden');
  $('settings-backdrop').classList.remove('hidden');
  try {
    const s   = await api('/api/settings');
    setDeviceUI(s.worker_device || 'cpu');
    const ts  = parseFloat(s.worker_last_seen || '0');
    const ago = ts ? Math.round((Date.now() / 1000 - ts) / 60) : null;
    $('worker-status-text').textContent =
      ago === null ? 'Worker has not connected yet'
      : ago < 2   ? 'Worker active'
      : ago < 60  ? `Last seen ${ago} min ago`
      :              `Last seen ${Math.round(ago / 60)}h ago`;
  } catch (e) { $('worker-status-text').textContent = 'Could not load settings'; }
}

function closeSettings() {
  $('settings-panel').classList.add('hidden');
  $('settings-backdrop').classList.add('hidden');
}

function setDeviceUI(d) {
  const active   = 'device-btn flex-1 py-3 rounded-xl text-sm font-semibold border border-[#22c55e] text-[#22c55e] bg-[#22c55e]/10 transition-all';
  const inactive = 'device-btn flex-1 py-3 rounded-xl text-sm font-semibold border border-[#1e2e1e] text-[#86efac] transition-all';
  $('device-mps').className = d === 'mps' ? active : inactive;
  $('device-cpu').className = d === 'cpu' ? active : inactive;
}

async function setDevice(d) {
  setDeviceUI(d);
  await api('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ worker_device: d }),
  });
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

const _kTimers = {}, _kSoloed = {};

document.addEventListener('keydown', e => {
  if ($('player-view').style.display === 'none') return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const key = e.key;
  if (key === ' ')          { e.preventDefault(); togglePlay();         return; }
  if (key === 'ArrowLeft')  { e.preventDefault(); seekRelative(-10);    return; }
  if (key === 'ArrowRight') { e.preventDefault(); seekRelative(10);     return; }
  if (key === 'ArrowUp')    { e.preventDefault(); adjustVolume(0.1);    return; }
  if (key === 'ArrowDown')  { e.preventDefault(); adjustVolume(-0.1);   return; }
  if (key === 'f' || key === 'F') { toggleFullscreen(); return; }
  if (key === 'm' || key === 'M') { toggleMute();       return; }
  if (key === 'l' || key === 'L') { cycleLyricsMode();  return; }
  const idx = parseInt(key, 10);
  if (idx >= 1 && idx <= 6 && !e.repeat) {
    const btn = document.querySelectorAll('#stem-grid .stem-btn')[idx - 1];
    if (!btn) return;
    const name    = btn.id.replace('stem-', '');
    _kSoloed[idx] = false;
    _kTimers[idx] = setTimeout(() => { _kSoloed[idx] = true; soloStem(name); }, 600);
  }
});

document.addEventListener('keyup', e => {
  if ($('player-view').style.display === 'none') return;
  const idx = parseInt(e.key, 10);
  if (idx >= 1 && idx <= 6) {
    clearTimeout(_kTimers[idx]);
    if (!_kSoloed[idx]) {
      const btn = document.querySelectorAll('#stem-grid .stem-btn')[idx - 1];
      if (btn) toggleStem(btn.id.replace('stem-', ''));
    }
    delete _kTimers[idx]; delete _kSoloed[idx];
  }
});

// ── Polling ───────────────────────────────────────────────────────────────────

function startPolling() {
  setInterval(() => {
    if ($('library-view').style.display !== 'none') refreshLibrary();
  }, 5000);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

// Library
$('btn-refresh').addEventListener('click', refreshLibrary);
$('btn-settings').addEventListener('click', openSettings);
$('btn-add').addEventListener('click', openAddSheet);
$('btn-chords').addEventListener('click', showChordLibrary);

// Player header
$('btn-back').addEventListener('click', closePlayer);
$('vol-btn').addEventListener('click', toggleMute);
$('btn-fullscreen').addEventListener('click', toggleFullscreen);
$('lyrics-toggle-btn').addEventListener('click', cycleLyricsMode);

// Progress bar
$('progress-bar').addEventListener('click', seekTo);
$('progress-bar').addEventListener('touchstart', touchSeek, { passive: false });
$('progress-bar').addEventListener('touchmove',  touchSeek, { passive: false });

// Transport
$('btn-seek-back').addEventListener('click',    () => seekRelative(-10));
$('play-btn').addEventListener('click',          togglePlay);
$('btn-seek-forward').addEventListener('click', () => seekRelative(10));

// Add sheet
$('sheet-backdrop').addEventListener('click', closeSheet);
$('tab-upload').addEventListener('click',  () => switchTab('upload'));
$('tab-youtube').addEventListener('click', () => switchTab('youtube'));
$('drop-zone').addEventListener('click',     () => $('file-input').click());
$('drop-zone').addEventListener('drop',      handleDrop);
$('drop-zone').addEventListener('dragover',  e => e.preventDefault());
$('file-input').addEventListener('change',   handleFileSelect);
$('yt-url').addEventListener('input',        onYtUrlInput);
$('add-btn').addEventListener('click',       submitSong);

// Chord detect BPM
$('chord-detect-btn').addEventListener('click', detectBPM);

// Chord tabs + strip controls
$('chord-tab-diagrams').addEventListener('click', () => setChordTab('diagrams'));
$('chord-tab-edit').addEventListener('click',     () => setChordTab('edit'));
$('chord-diagrams-btn').addEventListener('click', toggleDiagrams);
$('tempo-down').addEventListener('click', () => adjustTempo(-5));
$('tempo-up').addEventListener('click',   () => adjustTempo(5));
$('chord-edit-clear').addEventListener('click', () => { if (confirm('Clear all chords?')) clearAllChords(); });

// Chord library
$('chord-lib-back').addEventListener('click', showLibrary);
$('chord-lib-add').addEventListener('click',  () => openChordEditor(null));

// Chord editor
$('chord-editor-cancel').addEventListener('click', closeChordEditor);
$('chord-editor-save').addEventListener('click',   saveChordEditor);
$('chord-editor-delete').addEventListener('click',   deleteChordFromEditor);
$('chord-editor-barre-on').addEventListener('change', () => {
  $('chord-editor-barre-opts').classList.toggle('hidden', !$('chord-editor-barre-on').checked);
  renderEditorPreview();
});
['chord-editor-barre-fret', 'chord-editor-barre-from', 'chord-editor-barre-to'].forEach(id => {
  $( id ).addEventListener('input', renderEditorPreview);
});

// Settings
$('settings-backdrop').addEventListener('click', closeSettings);
$('device-mps').addEventListener('click', () => setDevice('mps'));
$('device-cpu').addEventListener('click', () => setDevice('cpu'));

// ── Boot ──────────────────────────────────────────────────────────────────────

switchTab('upload');
refreshLibrary();
startPolling();
