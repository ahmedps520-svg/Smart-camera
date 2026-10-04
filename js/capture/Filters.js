import { FILTERS } from '../config/defaults.js';

export const filterById = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

/** CSS filter string for live preview (GPU, zero-copy). */
export const cssFilter = (id) => filterById(id).css;

/**
 * Non-destructive filter application for export. Draws the source to a new
 * canvas and applies the look. Uses the canvas `filter` property when the
 * browser supports it (GPU path), otherwise a per-pixel fallback implementing
 * the same parametric adjustments. The source is never modified.
 */
export async function applyFilter(source, id, { maxSide = 0 } = {}) {
  const f = filterById(id);
  const sw = source.width, sh = source.height;
  const scale = maxSide ? Math.min(1, maxSide / Math.max(sw, sh)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (f.id === 'natural') { ctx.drawImage(source, 0, 0, canvas.width, canvas.height); return canvas; }
  const supportsFilter = typeof ctx.filter === 'string';
  if (supportsFilter) {
    ctx.filter = f.css;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    ctx.filter = 'none';
  } else {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    applyAdjustments(ctx, canvas.width, canvas.height, f.adj);
  }
  if (f.adj.vignette) drawVignette(ctx, canvas.width, canvas.height, f.adj.vignette);
  return canvas;
}

function drawVignette(ctx, w, h, strength) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

/** Per-pixel fallback: brightness, contrast, saturation, temperature, shadow lift. */
export function applyAdjustments(ctx, w, h, adj) {
  const img = ctx.getImageData(0, 0, w, h); const d = img.data;
  const br = adj.brightness ?? 1, ct = adj.contrast ?? 1, sat = adj.saturation ?? 1, temp = adj.temperature ?? 0, lift = adj.shadowLift ?? 0;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    r = (r - 128) * ct + 128; g = (g - 128) * ct + 128; b = (b - 128) * ct + 128;
    r *= br; g *= br; b *= br;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    r += temp; b -= temp;
    if (lift) { const k = lift * 255 * (1 - l / 255); r += k; g += k; b += k; }
    d[i] = r < 0 ? 0 : r > 255 ? 255 : r; d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  ctx.putImageData(img, 0, 0);
}
