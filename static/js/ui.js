'use strict';

import {
  resetPlayer, loadStems, beginLoad, isStaleLoad, getDuration,
  togglePlay, seekTo, touchSeek, seekRelative, doSeek,
  adjustVolume, setVolume, VOL_STEP, toggleMute, toggleFullscreen,
  toggleStem, soloStem, adjustTempo, setTempoPercent, TEMPO_STEP,
} from './player.js';
import {
  resetLyrics, initLyrics, cycleLyricsMode, setLyricsMode, getLyricsMode, setSeekFn,
  setSongDuration, setAutoscroll, isAutoscrollOn, needsAutoscroll,
  setAutoscrollSpeed, adjustAutoscrollSpeed, getAutoscrollSpeed, AS_STEP,
} from './chords.js';

// Wire lyric seek clicks through to the player
setSeekFn(doSeek);

const STATUS_COLOR = { done: '#22c55e', processing: '#fbbf24', pending: '#94a3b8', error: '#f87171', syncing: '#38bdf8' };
const STATUS_LABEL = { done: 'Ready', processing: 'Processing…', pending: 'Queued', error: 'Error', syncing: 'Syncing…' };

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
        <button class="edit-btn p-0.5 text-[#86efac] opacity-30 hover:opacity-80 hover:text-[#22c55e] transition-opacity active:scale-95" title="Edit title and artist">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
          </svg>
        </button>
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

  // Both live inside the card, which is itself the "open player" button
  el.querySelector('.edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    openEditSong(job);
  });

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

// ── Search + sort ─────────────────────────────────────────────────────────────
// Both are client-side: /api/jobs already returns the whole library in one call,
// so filtering here keeps the 5s poll from re-querying and, more importantly,
// keeps the typed term stable while the poll re-renders underneath it.

const SORT_KEY = 'jammate.librarySort';
let _libraryJobs = [];

// Accent-insensitive: the library is largely Spanish, so "cancion" must find
// "Canción" — same reasoning as smartMatchLyrics() in chords.js.
const fold = s => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// A song with no artist sorts last rather than first — an empty string would
// otherwise head the list and bury the named songs below it.
const byText = key => (a, b) => {
  const x = fold(a[key]), y = fold(b[key]);
  if (!x !== !y) return x ? -1 : 1;
  return x.localeCompare(y) || fold(a.title).localeCompare(fold(b.title));
};

const SORTERS = {
  recent: (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')),
  title:  byText('title'),
  artist: byText('artist'),
};

function getSort() {
  const v = $('library-sort').value;
  return SORTERS[v] ? v : 'recent';
}

function visibleJobs() {
  const term = fold($('library-search').value);
  const rows = term
    ? _libraryJobs.filter(j =>
        fold(j.title).includes(term) ||
        fold(j.artist).includes(term) ||
        fold(j.filename).includes(term))
    : _libraryJobs.slice();
  return rows.sort(SORTERS[getSort()]);
}

// Render from the cache — no fetch, so it is cheap enough to call on every
// keystroke.
function renderLibrary() {
  const grid  = $('song-grid');
  const empty = $('empty-state');
  const none  = $('no-results');
  const term  = $('library-search').value.trim();

  $('library-search-clear').classList.toggle('hidden', !term);

  const rows = visibleJobs();
  grid.innerHTML = '';
  empty.classList.toggle('hidden', _libraryJobs.length > 0);
  none.classList.toggle('hidden', !(_libraryJobs.length && !rows.length));
  $('no-results-term').textContent = term ? `“${term}”` : '';

  rows.forEach(j => grid.appendChild(renderCard(j)));
  updateBanner(_libraryJobs);
}

async function refreshLibrary() {
  try {
    _libraryJobs = await api('/api/jobs');
    renderLibrary();
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

// ── Edit song metadata ────────────────────────────────────────────────────────
// A YouTube title arrives as one string and `_parse_yt_title` has to guess which
// half is the artist — it guesses wrong often enough to need a fix-up. This is
// more than cosmetic: title and artist are what the LRCLIB and Cifra Club lookups
// search with, so a wrong one costs the song its lyrics and its chord sheet.
//
// Reached from the library rather than the player on purpose: a card is only
// clickable once it's `done`, so a pending or errored song could never be
// corrected from the player at all — and that's exactly when fixing the title
// still changes the outcome.

let _editJob = null;

function openEditSong(job) {
  _editJob = job;
  $('edit-title').value  = job.title || '';
  $('edit-artist').value = job.artist || '';
  $('edit-error').classList.add('hidden');
  $('edit-sheet').classList.add('open');
  $('edit-backdrop').classList.add('open');
  $('edit-title').focus();
}

function closeEditSong() {
  $('edit-sheet').classList.remove('open');
  $('edit-backdrop').classList.remove('open');
  _editJob = null;
}

function swapTitleArtist() {
  const title = $('edit-title').value;
  $('edit-title').value  = $('edit-artist').value;
  $('edit-artist').value = title;
}

async function saveEditSong() {
  if (!_editJob) return;
  const title  = $('edit-title').value.trim();
  const artist = $('edit-artist').value.trim();
  const err    = $('edit-error');
  // patch_job treats null as "don't touch" but writes an empty string, so a blank
  // artist clears it — a blank title would leave the song unsearchable instead.
  if (!title) {
    err.textContent = 'A title is required — it is what the lyrics search uses.';
    err.classList.remove('hidden');
    return;
  }
  const jobId = _editJob.id;
  const btn   = $('edit-save');
  btn.disabled = true;
  try {
    await api(`/api/jobs/${jobId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ title, artist }),
    });
    // Keep an open player's header honest about the song it's playing
    if (_currentPlayerJobId === jobId) {
      $('player-title').textContent  = title;
      $('player-artist').textContent = artist;
    }
    closeEditSong();
    refreshLibrary();
  } catch (e) {
    err.textContent = e.message || 'Failed to save';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

// ── Player ────────────────────────────────────────────────────────────────────

async function openPlayer(job) {
  resetPlayer();
  resetLyrics();
  const load = beginLoad();   // cancels any load still in flight from a previous tap

  $('player-title').textContent  = job.title || job.filename || 'Song';
  $('player-artist').textContent = job.artist || '';
  $('player-bpm').classList.add('hidden');
  $('stem-grid').classList.add('hidden');
  $('stem-loading').classList.remove('hidden');
  $('stem-loading-text').textContent = 'Loading stems…';
  $('progress-fill').style.width = '0%';
  $('time-current').textContent  = '0:00';
  $('time-total').textContent    = '0:00';
  showPlayer();

  try {
    const data = await api(`/api/stems/${job.id}`, { signal: load.signal });
    if (isStaleLoad(load)) return;
    _currentChordSheet     = data.chord_sheet || '';
    _currentChordSourceUrl = data.chord_source_url || '';
    initLyrics(data.chord_data, data.chord_source, data.chord_sheet);
    applySongMeta(job.id, data);
    await loadStems(job.id, data.stems || [], load);
    if (isStaleLoad(load)) return;
    // duration_sec is missing on older songs — the decoded stems know it anyway
    setSongDuration(data.duration_sec || getDuration());
  } catch (e) {
    if (isStaleLoad(load) || e.name === 'AbortError') return;
    $('stem-loading-text').textContent = 'Error: ' + e.message;
  }
}

function closePlayer() {
  resetPlayer();
  resetLyrics();
  stopAlignPoll();
  _currentPlayerJobId = null;
  closePlayerActions();
  showLibrary();
}

// ── Player Actions Sheet ──────────────────────────────────────────────────────

function openPlayerActions() {
  refreshLyricsControls();
  $('player-actions-sheet').classList.remove('hidden');
  $('player-actions-backdrop').classList.remove('hidden');
}

// Both lyrics rows depend on whether the song has anything to show, which a
// fetch or a sheet edit can change while the sheet is open
function refreshLyricsControls() {
  const available = !$('lyrics-toggle-btn').classList.contains('hidden');
  $('lyrics-section').classList.toggle('hidden', !available);
  $('autoscroll-section').classList.toggle('hidden', !available);
  updateLyricPills();
  updateAutoscrollUI();
}

function closePlayerActions() {
  $('player-actions-sheet').classList.add('hidden');
  $('player-actions-backdrop').classList.add('hidden');
}

function updateLyricPills() {
  const mode = getLyricsMode();
  const map = { 'lyrics-pill-off': null, 'lyrics-pill-chordify': 'chordify', 'lyrics-pill-spotify': 'spotify' };
  for (const [id, m] of Object.entries(map)) {
    const btn = $(id);
    if (!btn) continue;
    const active = mode === m;
    btn.classList.toggle('bg-[#22c55e]',    active);
    btn.classList.toggle('text-[#0a0f0a]',  active);
    btn.classList.toggle('border-[#22c55e]', active);
    btn.classList.toggle('text-[#86efac]',  !active);
  }
}

// ── Autoscroll ────────────────────────────────────────────────────────────────

let _scrollSaveTimer = null;

// Owns the whole autoscroll row, the way updateVolumeUI/updateTempoUI do
function updateAutoscrollUI() {
  const on    = isAutoscrollOn();
  const speed = getAutoscrollSpeed();
  $('autoscroll-label').textContent = on ? `${speed}%` : 'OFF';
  const value = $('autoscroll-toggle');
  value.classList.toggle('off-normal', on);
  $('autoscroll-down').disabled = !on;
  $('autoscroll-up').disabled   = !on;
}

function toggleAutoscroll() {
  setAutoscroll(!isAutoscrollOn());
  updateAutoscrollUI();
}

function stepAutoscroll(delta) {
  if (!isAutoscrollOn()) return;
  adjustAutoscrollSpeed(delta);
  updateAutoscrollUI();
  saveScrollSpeed();
}

// Taps come in bursts — only the settled value is worth a write
function saveScrollSpeed() {
  if (!_currentPlayerJobId) return;
  clearTimeout(_scrollSaveTimer);
  const jobId = _currentPlayerJobId;
  const speed = getAutoscrollSpeed();
  _scrollSaveTimer = setTimeout(() => {
    api(`/api/jobs/${jobId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ scroll_speed: speed }),
    }).catch(e => console.error('save scroll speed:', e));
  }, 600);
}

// ── Lyrics fetch ──────────────────────────────────────────────────────────────

async function fetchLyrics() {
  if (!_currentPlayerJobId) return;
  const jobId = _currentPlayerJobId;
  const btn   = $('lyrics-fetch-btn');
  const label = $('lyrics-fetch-label');
  btn.disabled      = true;
  label.textContent = '…';
  try {
    const res = await api(`/api/jobs/${jobId}/fetch-lyrics`, { method: 'POST' });
    if (_currentPlayerJobId !== jobId) return;   // player moved on while we waited
    const data = await api(`/api/stems/${jobId}`);
    resetLyrics();
    initLyrics(data.chord_data, data.chord_source, data.chord_sheet);
    setSongDuration(data.duration_sec || getDuration());
    applyAutoscrollDefault(data.scroll_speed);
    label.textContent = res.synced ? '✓ SYNCED' : '✓ PLAIN';
    setTimeout(() => { label.textContent = 'Lyrics'; }, 2500);
  } catch (e) {
    if (_currentPlayerJobId !== jobId) return;
    console.error('fetch lyrics:', e);
    // Stays on RETRY so the tile itself is the retry affordance
    label.textContent = 'RETRY';
    alert(e.message);
  } finally {
    if (_currentPlayerJobId === jobId) btn.disabled = false;
  }
}

// ── Local lyric alignment ─────────────────────────────────────────────────────
// The server only flips a flag; a worker does the work off /api/jobs/pending-align.
// So this is fire-and-poll, and the poller belongs to the tile — the player view
// has no loop of its own to hang it on.

const ALIGN_POLL_MS = 3000;
let _alignPoll = null;

function stopAlignPoll() {
  clearInterval(_alignPoll);
  _alignPoll = null;
}

function setAlignLabel(text) { $('lyrics-align-label').textContent = text; }

async function alignLyrics() {
  if (!_currentPlayerJobId) return;
  const jobId = _currentPlayerJobId;
  const btn = $('lyrics-align-btn');
  btn.disabled = true;
  setAlignLabel('…');
  try {
    await api(`/api/jobs/${jobId}/align-lyrics`, { method: 'POST' });
  } catch (e) {
    if (_currentPlayerJobId !== jobId) return;
    btn.disabled = false;
    // 409 is the "you already have real synced lyrics" guard — worth overriding
    // by hand, never by default.
    if (/already has synced lyrics/i.test(e.message)) {
      setAlignLabel('Sync');
      if (confirm('This song already has synced lyrics from LRCLIB. Re-time them locally anyway?')) {
        forceAlignLyrics(jobId);
      }
      return;
    }
    setAlignLabel('RETRY');
    alert(e.message);
    return;
  }
  watchAlign(jobId);
}

async function forceAlignLyrics(jobId) {
  const btn = $('lyrics-align-btn');
  btn.disabled = true;
  setAlignLabel('…');
  try {
    await api(`/api/jobs/${jobId}/align-lyrics?force=1`, { method: 'POST' });
  } catch (e) {
    if (_currentPlayerJobId !== jobId) return;
    btn.disabled = false;
    setAlignLabel('RETRY');
    alert(e.message);
    return;
  }
  watchAlign(jobId);
}

// Queued work needs a worker to be up, which may take a while — the label carries
// progress_phase so the wait reads as "waiting", not "broken".
function watchAlign(jobId) {
  stopAlignPoll();
  $('lyrics-align-btn').disabled = true;
  setAlignLabel('QUEUED');
  _alignPoll = setInterval(async () => {
    if (_currentPlayerJobId !== jobId) { stopAlignPoll(); return; }
    let job;
    try { job = await api(`/api/jobs/${jobId}`); } catch (e) { return; }
    if (_currentPlayerJobId !== jobId) { stopAlignPoll(); return; }

    if (job.align_status === 'running') {
      setAlignLabel(job.progress_phase === 'Aligning lyrics…' ? 'SYNCING' : 'RUNNING');
      return;
    }
    if (job.align_status === 'pending') return;   // still waiting for a worker

    stopAlignPoll();
    $('lyrics-align-btn').disabled = false;
    if (job.align_status === 'error') {
      setAlignLabel('FAILED');
      return;
    }
    // done — reload the timed lyrics into the view
    try {
      const data = await api(`/api/stems/${jobId}`);
      if (_currentPlayerJobId !== jobId) return;
      resetLyrics();
      initLyrics(data.chord_data, data.chord_source, data.chord_sheet);
      setSongDuration(data.duration_sec || getDuration());
      applyAutoscrollDefault(data.scroll_speed);
      showAlignScore(data.align_score);
    } catch (e) {
      console.error('reload aligned lyrics:', e);
      setAlignLabel('Sync');
    }
  }, ALIGN_POLL_MS);
}

// A weak alignment is used anyway, so the score has to be visible rather than
// silently trusted.
function showAlignScore(score) {
  setAlignLabel(score ? `✓ ${Number(score).toFixed(2)}` : '✓ SYNCED');
}

// Autoscroll turns itself on for songs with nothing timed to follow — that is
// the whole point of it, so the user shouldn't have to ask after a failed fetch.
function applyAutoscrollDefault(savedSpeed) {
  setAutoscrollSpeed(savedSpeed || 100);
  setAutoscroll(needsAutoscroll());
  refreshLyricsControls();
}

// ── Add Song ──────────────────────────────────────────────────────────────────

let activeTab    = 'youtube';   // YouTube is the common path; upload is the fallback
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
  switchTab('youtube');
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

// ── Song meta (BPM badge, action tiles) ───────────────────────────────────────

let _currentPlayerJobId    = null;
let _currentChordSheet     = '';
let _currentChordSourceUrl = '';

function applySongMeta(jobId, data) {
  _currentPlayerJobId = jobId;
  $('actions-tile-section').classList.remove('hidden');
  const bpmBadge = $('player-bpm');
  if (data.bpm) {
    bpmBadge.textContent = `${Math.round(data.bpm)} BPM`;
    bpmBadge.classList.remove('hidden');
  } else {
    bpmBadge.classList.add('hidden');
  }
  applyAutoscrollDefault(data.scroll_speed);
  $('lyrics-fetch-label').textContent = 'Lyrics';
  $('lyrics-fetch-btn').disabled = false;

  // A queued alignment survives closing the player, so pick the poll back up
  // rather than showing an idle tile over work that is still in flight.
  stopAlignPoll();
  $('lyrics-align-btn').disabled = false;
  if (data.align_status === 'pending' || data.align_status === 'running') {
    watchAlign(jobId);
  } else if (data.align_status === 'done' && data.chord_source === 'aligned') {
    showAlignScore(data.align_score);
  } else {
    setAlignLabel('Sync');
  }
}

async function detectBPM() {
  if (!_currentPlayerJobId) return;
  closePlayerActions();
  const btn   = $('chord-detect-btn');
  const label = $('chord-detect-label');
  btn.disabled = true;
  label.textContent = '…';
  try {
    const data = await api(`/api/jobs/${_currentPlayerJobId}/detect-bpm`, { method: 'POST' });
    $('player-bpm').textContent = `${Math.round(data.bpm)} BPM`;
    $('player-bpm').classList.remove('hidden');
  } catch (e) {
    label.textContent = 'ERR';
    setTimeout(() => { label.textContent = 'BPM'; btn.disabled = false; }, 2000);
    return;
  }
  btn.disabled = false;
  label.textContent = 'BPM';
}

// ── Chord sheet modal ─────────────────────────────────────────────────────────

function openChordSheetModal() {
  // The actions sheet is z-50 and this modal is z-30 — it has to get out of the way
  closePlayerActions();
  $('chord-sheet-input').value = _currentChordSheet;
  $('cifra-url-input').value   = _currentChordSourceUrl;
  $('cifra-fetch-status').textContent = '';
  $('chord-sheet-modal').classList.remove('hidden');
  $('chord-sheet-input').focus();
}

function closeChordSheetModal() {
  $('chord-sheet-modal').classList.add('hidden');
}

async function saveChordSheet() {
  if (!_currentPlayerJobId) return;
  const value = $('chord-sheet-input').value;
  try {
    await api(`/api/jobs/${_currentPlayerJobId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chord_sheet: value }),
    });
    _currentChordSheet = value;
    const data = await api(`/api/stems/${_currentPlayerJobId}`);
    resetLyrics();
    initLyrics(data.chord_data, data.chord_source, data.chord_sheet);
    setSongDuration(data.duration_sec || getDuration());
    applyAutoscrollDefault(data.scroll_speed);
    closeChordSheetModal();
  } catch (e) {
    alert('Failed to save chord sheet: ' + e.message);
  }
}

async function clearChordSheet() {
  if (!_currentPlayerJobId) return;
  if (!confirm('Clear the chord sheet?')) return;
  try {
    await api(`/api/jobs/${_currentPlayerJobId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chord_sheet: '' }),
    });
    _currentChordSheet = '';
    $('chord-sheet-input').value = '';
    const data = await api(`/api/stems/${_currentPlayerJobId}`);
    resetLyrics();
    initLyrics(data.chord_data, data.chord_source, data.chord_sheet);
    setSongDuration(data.duration_sec || getDuration());
    applyAutoscrollDefault(data.scroll_speed);
    closeChordSheetModal();
  } catch (e) {
    console.error('clear chord sheet:', e);
  }
}

async function fetchCifraSheet() {
  if (!_currentPlayerJobId) return;
  const urlInput = $('cifra-url-input');
  const status   = $('cifra-fetch-status');
  const btn      = $('cifra-fetch-btn');
  const url      = urlInput.value.trim();
  btn.disabled   = true;
  status.textContent = url ? 'Fetching…' : 'Searching Cifra Club…';
  try {
    const data = await api(`/api/jobs/${_currentPlayerJobId}/fetch-cifra`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
    });
    $('chord-sheet-input').value = data.chord_sheet;
    _currentChordSheet           = data.chord_sheet;
    _currentChordSourceUrl       = data.source_url || url;
    if (data.source_url) urlInput.value = data.source_url;
    status.textContent = 'Fetched — review and click Save';
    status.style.color = '#4ade80';
  } catch (e) {
    status.textContent = e.message || 'Failed to fetch';
    status.style.color = '#f87171';
  } finally {
    btn.disabled = false;
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

    $('sync-hub-url').value = s.sync_hub_url || '';
    $('sync-token').value   = s.sync_token   || '';   // server sends *** if one is set
    refreshSyncStatus();
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

// ── Song sync ─────────────────────────────────────────────────────────────────

let syncPoll = null;

async function saveSyncSettings() {
  // A token left as the *** the server sent back means "unchanged" — the server
  // drops that value rather than overwriting the real one with asterisks.
  await api('/api/settings', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      sync_hub_url: $('sync-hub-url').value.trim(),
      sync_token:   $('sync-token').value,
    }),
  });
  refreshSyncStatus();
}

function renderSyncStatus(s) {
  const el = $('sync-status');
  if (s.is_hub) {
    el.textContent = 'This instance is the hub — other devices sync from it.';
    return;
  }
  if (s.running) { el.textContent = s.phase || 'Syncing…'; return; }

  const mode = s.read_only ? 'Mirror (pull only) — ' : '';
  const parts = [];
  if (s.pulled)        parts.push(`${s.pulled} in`);
  if (s.pushed)        parts.push(`${s.pushed} out`);
  if (s.handed_off)    parts.push(`${s.handed_off} queued on hub`);
  if (s.deleted_local || s.deleted_remote)
    parts.push(`${s.deleted_local + s.deleted_remote} deleted`);
  if (s.bytes) parts.push(`${(s.bytes / 1048576).toFixed(1)} MB`);

  let txt = mode + (s.finished_at
    ? (parts.length ? parts.join(' · ') : 'Already up to date')
    : 'Not synced yet');
  if (s.warnings?.length) txt += `\n⚠ ${s.warnings.join('; ')}`;
  if (s.errors?.length)   txt += `\n✕ ${s.errors.join('; ')}`;
  el.textContent = txt;
  el.style.whiteSpace = 'pre-line';
}

async function refreshSyncStatus() {
  try { renderSyncStatus(await api('/api/sync/status')); } catch (e) { /* offline */ }
}

async function syncNow() {
  const btn = $('sync-now');
  btn.disabled = true;
  try {
    await saveSyncSettings();
    await api('/api/sync/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ direction: 'both' }),
    });

    clearInterval(syncPoll);
    syncPoll = setInterval(async () => {
      let s;
      try { s = await api('/api/sync/status'); } catch (e) { return; }
      renderSyncStatus(s);
      if (!s.running) {
        clearInterval(syncPoll);
        syncPoll = null;
        btn.disabled = false;
        refreshLibrary();     // songs that landed should show up straight away
      }
    }, 1500);
  } catch (e) {
    $('sync-status').textContent = e.message || 'Sync failed to start';
    btn.disabled = false;
  }
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
$('library-search').addEventListener('input', renderLibrary);
$('library-search').addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('library-search').value = ''; renderLibrary(); }
});
$('library-search-clear').addEventListener('click', () => {
  $('library-search').value = '';
  $('library-search').focus();
  renderLibrary();
});
$('library-sort').addEventListener('change', () => {
  try { localStorage.setItem(SORT_KEY, getSort()); } catch (e) { /* private mode */ }
  renderLibrary();
});
$('btn-settings').addEventListener('click', openSettings);
$('btn-add').addEventListener('click', openAddSheet);

// Player header
$('btn-back').addEventListener('click', closePlayer);
$('btn-fullscreen').addEventListener('click', toggleFullscreen);
$('btn-player-actions').addEventListener('click', openPlayerActions);
$('player-actions-backdrop').addEventListener('click', closePlayerActions);

// Actions sheet — volume stepper
$('vol-btn').addEventListener('click', toggleMute);
$('vol-down').addEventListener('click',  () => adjustVolume(-VOL_STEP));
$('vol-up').addEventListener('click',    () => adjustVolume(VOL_STEP));
$('vol-reset').addEventListener('click', () => setVolume(1));

// Actions sheet — tempo stepper
$('tempo-down').addEventListener('click',  () => adjustTempo(-TEMPO_STEP));
$('tempo-up').addEventListener('click',    () => adjustTempo(TEMPO_STEP));
$('tempo-reset').addEventListener('click', () => setTempoPercent(100));

// Actions sheet — lyrics
$('lyrics-pill-off').addEventListener('click',      () => { setLyricsMode(null);        updateLyricPills(); closePlayerActions(); });
$('lyrics-pill-chordify').addEventListener('click', () => { setLyricsMode('chordify');  updateLyricPills(); closePlayerActions(); });
$('lyrics-pill-spotify').addEventListener('click',  () => { setLyricsMode('spotify');   updateLyricPills(); closePlayerActions(); });

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

// Lyrics fetch + local alignment + autoscroll fallback
$('lyrics-fetch-btn').addEventListener('click',   fetchLyrics);
$('lyrics-align-btn').addEventListener('click',   alignLyrics);
$('autoscroll-toggle').addEventListener('click',  toggleAutoscroll);
$('autoscroll-down').addEventListener('click',    () => stepAutoscroll(-AS_STEP));
$('autoscroll-up').addEventListener('click',      () => stepAutoscroll(AS_STEP));

// Chord sheet modal
$('chord-sheet-open-btn').addEventListener('click', openChordSheetModal);
$('chord-sheet-close').addEventListener('click',    closeChordSheetModal);
$('chord-sheet-cancel').addEventListener('click',   closeChordSheetModal);
$('chord-sheet-save').addEventListener('click',     saveChordSheet);
$('chord-sheet-clear-btn').addEventListener('click', clearChordSheet);
$('cifra-fetch-btn').addEventListener('click',      fetchCifraSheet);

// Edit song sheet
$('edit-backdrop').addEventListener('click', closeEditSong);
$('edit-cancel').addEventListener('click',   closeEditSong);
$('edit-swap').addEventListener('click',     swapTitleArtist);
$('edit-save').addEventListener('click',     saveEditSong);
['edit-title', 'edit-artist'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') saveEditSong(); }));

// Settings
$('settings-backdrop').addEventListener('click', closeSettings);
$('device-mps').addEventListener('click', () => setDevice('mps'));
$('device-cpu').addEventListener('click', () => setDevice('cpu'));
$('sync-hub-url').addEventListener('change', saveSyncSettings);
$('sync-token').addEventListener('change', saveSyncSettings);
$('sync-now').addEventListener('click', syncNow);

// ── Boot ──────────────────────────────────────────────────────────────────────

switchTab('upload');
try {
  const saved = localStorage.getItem(SORT_KEY);
  if (saved && SORTERS[saved]) $('library-sort').value = saved;
} catch (e) { /* private mode — fall back to Recent */ }
refreshLibrary();
startPolling();
