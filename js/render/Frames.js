/**
 * Photo frames for the editor and exports (all non-destructive):
 *  - none   the photo as shot
 *  - white  clean white border
 *  - paper  warm off-white paper border with a fine fibre texture
 *  - specs  instant-film style border with "Shot on …" and the camera specs
 *  - date   orange film date stamp in the corner
 */
export const FRAMES = [
  { id: 'none', name: 'Original' },
  { id: 'white', name: 'White' },
  { id: 'paper', name: 'Paper' },
  { id: 'specs', name: 'Specs' },
  { id: 'date', name: 'Date' },
];

/** Equivalent focal length on iPhone-style lenses: 13 mm ultra wide, 24 mm main, × zoom; 23 mm front. */
export function focalLength({ zoom = 1, selfie = false } = {}) {
  if (selfie) return 23;
  if (zoom < 0.95) return 13;
  return Math.round(24 * zoom);
}

/** Specs line from what the camera actually reported (nothing is made up). */
export function specsLine(meta = {}) {
  const parts = [`${meta.focal ?? focalLength(meta)}mm`];
  if (meta.zoom && Math.abs(meta.zoom - 1) > 0.01 && !meta.selfie) parts.push(`${+meta.zoom.toFixed(1)}×`);
  if (meta.exposureTime) parts.push(`1/${Math.max(1, Math.round(1 / meta.exposureTime))}s`);
  if (meta.iso) parts.push(`ISO${Math.round(meta.iso)}`);
  return parts.join('   ');
}

export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `'${p(d.getFullYear() % 100)}  ${p(d.getMonth() + 1)}  ${p(d.getDate())}`;
}

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';

/** Deterministic pseudo-random for paper texture. */
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/**
 * @param {HTMLCanvasElement} src rendered photo
 * @param {string} id frame id
 * @param {{date?: Date, device?: string, specs?: string}} info
 * @returns {HTMLCanvasElement}
 */
export function applyFrame(src, id, info = {}) {
  if (!id || id === 'none') return src;
  const w = src.width, h = src.height, m = Math.min(w, h);
  const out = document.createElement('canvas');
  const ctx = () => out.getContext('2d', { alpha: false });

  if (id === 'date') {
    out.width = w; out.height = h;
    const c = ctx(); c.drawImage(src, 0, 0);
    const size = Math.max(10, Math.round(m * 0.045));
    c.font = `600 ${size}px "Courier New", ui-monospace, Menlo, monospace`;
    c.textAlign = 'right'; c.textBaseline = 'alphabetic';
    c.shadowColor = 'rgba(255,120,30,0.85)'; c.shadowBlur = size * 0.35;
    c.fillStyle = '#ff9a3c';
    c.fillText(dateStamp(info.date), w - m * 0.05, h - m * 0.05);
    return out;
  }

  if (id === 'white' || id === 'paper') {
    const b = Math.round(m * (id === 'paper' ? 0.06 : 0.045));
    out.width = w + 2 * b; out.height = h + 2 * b;
    const c = ctx();
    c.fillStyle = id === 'paper' ? '#efe9dc' : '#ffffff'; c.fillRect(0, 0, out.width, out.height);
    if (id === 'paper') {
      const r = rng(w * 31 + h);
      const n = Math.round(out.width * out.height / 900);
      for (let i = 0; i < n; i++) {
        const x = r() * out.width, y = r() * out.height, l = 1 + r() * m * 0.012;
        c.strokeStyle = r() > 0.5 ? 'rgba(120,100,70,0.07)' : 'rgba(255,255,255,0.35)';
        c.lineWidth = Math.max(0.5, m * 0.0012);
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * l, y + (r() - 0.5) * l); c.stroke();
      }
      c.shadowColor = 'rgba(0,0,0,0.25)'; c.shadowBlur = m * 0.01;
    }
    c.drawImage(src, b, b);
    return out;
  }

  if (id === 'specs') {
    const side = Math.round(m * 0.035), bottom = Math.round(m * 0.17);
    out.width = w + 2 * side; out.height = h + side + bottom;
    const c = ctx();
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, out.width, out.height);
    c.drawImage(src, side, side);
    const cx = out.width / 2, y0 = side + h;
    const s1 = Math.max(9, Math.round(m * 0.03)), s2 = Math.max(7, Math.round(m * 0.021));
    // "Shot on" light + device bold, measured so the pair is centred.
    c.textBaseline = 'middle';
    c.font = `400 ${s1}px ${FONT}`; const a = 'Shot on ';
    const aw = c.measureText(a).width;
    c.font = `700 ${s1}px ${FONT}`; const dev = info.device || 'iPhone';
    const dw = c.measureText(dev).width;
    const x = cx - (aw + dw) / 2, y1 = y0 + bottom * 0.42;
    c.fillStyle = '#6b6b6b'; c.font = `400 ${s1}px ${FONT}`; c.textAlign = 'left'; c.fillText(a, x, y1);
    c.fillStyle = '#111111'; c.font = `700 ${s1}px ${FONT}`; c.fillText(dev, x + aw, y1);
    if (info.specs) { c.font = `400 ${s2}px ${FONT}`; c.fillStyle = '#9a9a9a'; c.textAlign = 'center'; c.fillText(info.specs, cx, y0 + bottom * 0.68); }
    return out;
  }
  return src;
}
