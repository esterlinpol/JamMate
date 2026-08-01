'use strict';

// Keeps the screen awake while a song is playing.
//
// Two strategies, because the Screen Wake Lock API needs a secure context and
// the app is served over plain http on the LAN — so on a phone reaching
// http://<mac-ip>:8000, navigator.wakeLock is simply undefined:
//   1. navigator.wakeLock — used on localhost and any https origin
//   2. a muted, looping, off-screen video — the fallback that works anywhere,
//      since a playing video suppresses the display sleep timer

// Seeking and tempo changes pause-then-play within a few ms; releasing the lock
// on that round trip would thrash it, so releases wait this long to be undone.
const RELEASE_DELAY_MS = 1500;

let sentinel = null;   // WakeLockSentinel from the API path
let videoEl  = null;   // fallback <video>
let wanted   = false;  // whether playback currently wants the screen on
let relTimer = null;   // pending release

const supportsApi = () => 'wakeLock' in navigator;

async function acquireApi() {
  try {
    sentinel = await navigator.wakeLock.request('screen');
    // The browser drops the lock on tab switch, sleep, etc. — clear our handle
    // so the visibility listener knows to ask again.
    sentinel.addEventListener('release', () => { sentinel = null; });
    return true;
  } catch (e) {
    // NotAllowedError (no user gesture, battery saver, permissions policy)
    console.warn('[JamMate] wake lock refused, falling back to video:', e.name);
    sentinel = null;
    return false;
  }
}

function ensureVideo() {
  if (videoEl) return videoEl;
  const v = document.createElement('video');
  v.setAttribute('playsinline', '');   // iOS: don't hijack into fullscreen
  v.setAttribute('muted', '');
  v.setAttribute('loop', '');
  v.muted  = true;                     // attribute alone isn't enough in Safari
  v.loop   = true;
  v.width  = 1;
  v.height = 1;
  // Off-screen rather than display:none — a hidden video may not be allowed to play
  v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;bottom:-10px';
  v.innerHTML = `
    <source src="/static/media/keep-awake.webm" type="video/webm">
    <source src="/static/media/keep-awake.mp4" type="video/mp4">`;
  document.body.appendChild(v);
  videoEl = v;
  return v;
}

function acquireVideo() {
  const v = ensureVideo();
  v.play().catch(e => console.warn('[JamMate] keep-awake video blocked:', e.name));
}

// Called from play(). Must run inside the click handler's task so the gesture
// still counts — do not await anything before requesting.
export function keepScreenAwake() {
  wanted = true;
  clearTimeout(relTimer);
  relTimer = null;
  if (supportsApi()) {
    if (!sentinel) acquireApi().then(ok => { if (!ok && wanted) acquireVideo(); });
  } else {
    acquireVideo();
  }
}

export function releaseScreenAwake() {
  wanted = false;
  clearTimeout(relTimer);
  relTimer = setTimeout(() => {
    relTimer = null;
    if (wanted) return;
    if (sentinel) { sentinel.release().catch(() => {}); sentinel = null; }
    if (videoEl && !videoEl.paused) videoEl.pause();
  }, RELEASE_DELAY_MS);
}

// Coming back to the tab mid-playback: the API lock was released while hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !wanted) return;
  if (supportsApi() && !sentinel) acquireApi();
  else if (videoEl && videoEl.paused) acquireVideo();
});
