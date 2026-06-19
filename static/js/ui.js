'use strict';

import {
  resetPlayer, loadStems, togglePlay, seekTo, touchSeek, seekRelative, doSeek,
  adjustVolume, toggleMute, toggleFullscreen, toggleStem, soloStem,
} from './player.js';
import {
  resetLyrics, initLyrics, cycleLyricsMode, setSeekFn,
} from './chords.js';

// Wire lyric seek clicks through to the player
setSeekFn(doSeek);

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
  $('library-view').style.display = '';
  $('player-view').style.display  = 'none';
}

function showPlayer() {
  $('library-view').style.display = 'none';
  $('player-view').style.display  = '';
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
    await loadStems(job.id, data.stems || []);
  } catch (e) {
    $('stem-loading-text').textContent = 'Error: ' + e.message;
  }
}

function closePlayer() {
  resetPlayer();
  resetLyrics();
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

// Settings
$('settings-backdrop').addEventListener('click', closeSettings);
$('device-mps').addEventListener('click', () => setDevice('mps'));
$('device-cpu').addEventListener('click', () => setDevice('cpu'));

// ── Boot ──────────────────────────────────────────────────────────────────────

switchTab('upload');
refreshLibrary();
startPolling();
