// Chord library: API helpers + SVG fretboard diagram renderer

// ── API ───────────────────────────────────────────────────────────────────────

export async function fetchChords() {
  const r = await fetch('/api/chords');
  return r.json();
}

export async function createChord(data) {
  const r = await fetch('/api/chords', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}

export async function updateChord(id, data) {
  const r = await fetch(`/api/chords/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}

export async function deleteChord(id) {
  const r = await fetch(`/api/chords/${id}`, { method: 'DELETE' });
  return r.json();
}

// ── SVG Diagram Renderer ──────────────────────────────────────────────────────

const SIZES = {
  small:  { w: 64,  h: 60,  frets: 3, dotR: 6,  fontSize: 7,  nutH: 4  },
  medium: { w: 90,  h: 80,  frets: 3, dotR: 8,  fontSize: 9,  nutH: 5  },
  large:  { w: 140, h: 120, frets: 3, dotR: 12, fontSize: 12, nutH: 7  },
  xl:     { w: 190, h: 160, frets: 3, dotR: 16, fontSize: 15, nutH: 9  },
};

const FINGER_COLORS = ['#22c55e', '#22c55e', '#22c55e', '#22c55e', '#22c55e'];

/**
 * Render a chord SVG element.
 * @param {Object} chord  - { name, frets (JSON), fingers (JSON), barre (JSON|null) }
 * @param {'small'|'medium'|'large'} variant
 * @returns {SVGElement}
 */
export function renderChordSVG(chord, variant = 'medium') {
  const cfg = SIZES[variant] || SIZES.medium;
  const frets = typeof chord.frets === 'string' ? JSON.parse(chord.frets) : chord.frets;
  const fingers = typeof chord.fingers === 'string' ? JSON.parse(chord.fingers) : (chord.fingers || [0,0,0,0,0,0]);
  const barre = chord.barre ? (typeof chord.barre === 'string' ? JSON.parse(chord.barre) : chord.barre) : null;

  const strings = 6;
  const numFrets = cfg.frets;

  // Compute min fret to shift diagram window (ignore open/muted)
  const frettedFrets = frets.filter(f => f > 0);
  const minFret = frettedFrets.length ? Math.min(...frettedFrets) : 1;
  const lowestFret = barre ? Math.min(barre.fret, minFret) : minFret;
  const startFret = (lowestFret <= 1 || frets.some(f => f === 0)) ? 1 : lowestFret;

  // Layout
  const topPad = cfg.fontSize * 2;       // space for open/muted symbols
  const leftPad = Math.max(cfg.fontSize * 1.5, cfg.dotR);  // space for fret number + left dot overflow
  const rightPad = cfg.dotR;                               // right dot overflow clearance
  const bottomPad = 8;
  const gridW = cfg.w - leftPad - rightPad;
  const gridH = cfg.h - topPad - bottomPad;
  const strGap = gridW / (strings - 1);
  const fretGap = gridH / numFrets;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${cfg.w} ${cfg.h}`);
  svg.setAttribute('width', cfg.w);
  svg.setAttribute('height', cfg.h);

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ── Nut or fret number ────────────────────────────────────────────────────
  if (startFret === 1) {
    // thick nut line
    el('rect', {
      x: leftPad, y: topPad,
      width: gridW, height: cfg.nutH,
      fill: '#f0fdf4',
    }, svg);
  } else {
    // fret number label
    el('text', {
      x: leftPad - 3, y: topPad + fretGap * 0.6,
      'font-size': cfg.fontSize,
      fill: '#86efac',
      'text-anchor': 'end',
      'dominant-baseline': 'middle',
      'font-family': 'monospace',
    }, svg).textContent = startFret;
  }

  // ── Fret lines ────────────────────────────────────────────────────────────
  for (let f = 0; f <= numFrets; f++) {
    const y = topPad + (startFret === 1 ? cfg.nutH : 0) + f * fretGap;
    el('line', {
      x1: leftPad, y1: y,
      x2: leftPad + gridW, y2: y,
      stroke: '#2d4a2d', 'stroke-width': 1,
    }, svg);
  }

  // ── String lines ──────────────────────────────────────────────────────────
  const nutOffset = startFret === 1 ? cfg.nutH : 0;
  for (let s = 0; s < strings; s++) {
    const x = leftPad + s * strGap;
    el('line', {
      x1: x, y1: topPad + nutOffset,
      x2: x, y2: topPad + nutOffset + numFrets * fretGap,
      stroke: '#4ade80', 'stroke-width': 1,
    }, svg);
  }

  // ── Open / Muted symbols above nut ───────────────────────────────────────
  for (let s = 0; s < strings; s++) {
    const f = frets[s];
    if (f === 0 || f === -1) {
      const x = leftPad + s * strGap;
      const y = topPad - cfg.fontSize * 0.6;
      el('text', {
        x, y,
        'font-size': cfg.fontSize,
        fill: f === 0 ? '#86efac' : '#f87171',
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-family': 'monospace',
      }, svg).textContent = f === 0 ? '○' : '✕';
    }
  }

  // ── Barre ────────────────────────────────────────────────────────────────
  if (barre) {
    const fretIdx = barre.fret - startFret;
    const y = topPad + nutOffset + fretIdx * fretGap + fretGap * 0.5;
    const x1 = leftPad + barre.from * strGap;
    const x2 = leftPad + barre.to * strGap;
    el('rect', {
      x: x1 - cfg.dotR * 0.6,
      y: y - cfg.dotR,
      width: (x2 - x1) + cfg.dotR * 1.2,
      height: cfg.dotR * 2,
      rx: cfg.dotR,
      fill: '#22c55e',
    }, svg);
  }

  // ── Finger dots ───────────────────────────────────────────────────────────
  for (let s = 0; s < strings; s++) {
    const f = frets[s];
    if (f <= 0) continue;
    // skip strings covered by barre at exact barre fret (barre renders them)
    if (barre && f === barre.fret && s >= barre.from && s <= barre.to) continue;
    const fretIdx = f - startFret;
    const cx = leftPad + s * strGap;
    const cy = topPad + nutOffset + fretIdx * fretGap + fretGap * 0.5;
    el('circle', { cx, cy, r: cfg.dotR, fill: '#22c55e' }, svg);
    if (fingers[s]) {
      el('text', {
        x: cx, y: cy,
        'font-size': cfg.dotR * 1.2,
        fill: '#0a0f0a',
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-weight': 'bold',
        'font-family': 'monospace',
      }, svg).textContent = fingers[s];
    }
  }

  return svg;
}
