/**
 * Burst "best shot" selection. Each frame is scored on sharpness (variance of
 * the Laplacian on a small greyscale copy), eyes open and pose/framing quality;
 * only the current best full-resolution frame is kept in memory.
 */

/** Variance of the Laplacian of an ImageData's luminance (higher = sharper). */
export function sharpness(img) {
  const { data, width: w, height: h } = img;
  const Y = new Float32Array(w * h);
  for (let i = 0, j = 0; j < Y.length; i += 4, j++) Y[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x;
    const lap = 4 * Y[k] - Y[k - 1] - Y[k + 1] - Y[k - w] - Y[k + w];
    sum += lap; sq += lap * lap; n++;
  }
  if (!n) return 0;
  const m = sum / n;
  return sq / n - m * m;
}

export class BurstSelector {
  constructor() { this.frames = 0; this.maxSharp = 1e-6; this.best = null; this.items = []; }

  /** Composite score in 0…1 given the running sharpness maximum. */
  score(item) {
    const s = Math.min(1, item.sharp / this.maxSharp);
    return s * 0.55 + (item.eyesOpen ?? 1) * 0.3 + Math.min(1, (item.quality ?? 70) / 100) * 0.15;
  }

  /**
   * Offer a frame. `keep()` is only called when this frame becomes the best,
   * so the caller can avoid copying full-resolution pixels for rejected frames.
   * @returns true when the frame is the new best.
   */
  offer({ sharp, eyesOpen = 1, quality = 70 }, keep = () => null) {
    this.frames++;
    this.maxSharp = Math.max(this.maxSharp, sharp);
    const item = { sharp, eyesOpen, quality, index: this.frames - 1 };
    this.items.push(item);
    if (!this.best || this.score(item) > this.score(this.best)) { this.best = { ...item, payload: keep() }; return true; }
    return false;
  }
}
