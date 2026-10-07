/**
 * Follows the chosen subject between frames by template matching
 * (normalised cross-correlation) on a small greyscale copy of the view.
 * Cheap enough to run every frame, robust for tiny far-away subjects that
 * detectors only see intermittently (a distant boat), and re-anchored by the
 * detector whenever it does see the subject.
 */
export function toGray(img) {
  const { data, width: w, height: h } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return { data: g, w, h };
}

export class TemplateTracker {
  constructor() { this.tpl = null; this.misses = 0; this.confidence = 0; }

  get active() { return !!this.tpl; }

  /** @param box normalised view box of the subject */
  init(gray, box) {
    const { w, h } = gray;
    const P = Math.max(10, Math.min(28, Math.round(Math.min(box.w * w, box.h * h) * 0.9))) & ~1;
    this.P = P;
    this.cx = (box.x + box.w / 2) * w; this.cy = (box.y + box.h / 2) * h;
    this.bw = box.w; this.bh = box.h;
    this.tpl = this.patch(gray, Math.round(this.cx), Math.round(this.cy));
    this.misses = 0; this.confidence = 1;
    this.size = { w, h };
  }

  patch(gray, cx, cy) {
    const { data, w, h } = gray, P = this.P, half = P / 2;
    const out = new Float32Array(P * P);
    let s = 0;
    for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
      const sx = Math.min(w - 1, Math.max(0, cx - half + x)), sy = Math.min(h - 1, Math.max(0, cy - half + y));
      const v = data[sy * w + sx]; out[y * P + x] = v; s += v;
    }
    const m = s / out.length; let q = 0;
    for (let i = 0; i < out.length; i++) { out[i] -= m; q += out[i] * out[i]; }
    out.norm = Math.sqrt(q) || 1;
    return out;
  }

  ncc(gray, cx, cy) {
    const { data, w } = gray, P = this.P, half = P / 2, t = this.tpl;
    if (cx - half < 0 || cy - half < 0 || cx + half >= w || cy + half >= gray.h) return -1;
    let s = 0;
    for (let y = 0; y < P; y++) { const row = (cy - half + y) * w + (cx - half); for (let x = 0; x < P; x++) s += data[row + x]; }
    const m = s / (P * P);
    let num = 0, q = 0;
    for (let y = 0; y < P; y++) {
      const row = (cy - half + y) * w + (cx - half);
      for (let x = 0; x < P; x++) { const v = data[row + x] - m; num += v * t[y * P + x]; q += v * v; }
    }
    return num / ((Math.sqrt(q) || 1) * t.norm);
  }

  /** @returns {{box, confidence, lost}} */
  update(gray) {
    if (!this.tpl) return null;
    const R = Math.round(Math.max(gray.w, gray.h) * 0.12);
    let best = -2, bx = this.cx, by = this.cy;
    const cx0 = Math.round(this.cx), cy0 = Math.round(this.cy);
    // Small distance prior: on ambiguous (smooth) content prefer staying put.
    const prior = 0.06 / R;
    let bestScore = -2;
    for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
      const v = this.ncc(gray, cx0 + dx, cy0 + dy); const sc = v - prior * Math.hypot(dx, dy);
      if (sc > bestScore) { bestScore = sc; best = v; bx = cx0 + dx; by = cy0 + dy; }
    }
    const fx = bx, fy = by;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const v = this.ncc(gray, fx + dx, fy + dy); if (v > best) { best = v; bx = fx + dx; by = fy + dy; }
    }
    this.confidence = best;
    if (best < 0.45) this.misses++;
    else {
      this.misses = 0; this.cx = bx; this.cy = by;
      if (best > 0.75) { const p = this.patch(gray, bx, by); for (let i = 0; i < p.length; i++) this.tpl[i] = this.tpl[i] * 0.9 + p[i] * 0.1; let q = 0; for (let i = 0; i < this.tpl.length; i++) q += this.tpl[i] * this.tpl[i]; this.tpl.norm = Math.sqrt(q) || 1; }
    }
    return { box: this.box(gray), confidence: best, lost: this.misses > 6 };
  }

  box(gray = this.size) {
    return { x: this.cx / gray.w - this.bw / 2, y: this.cy / gray.h - this.bh / 2, w: this.bw, h: this.bh };
  }

  /** The view was zoomed by factor k about its centre: predict where the subject went. */
  zoomBy(k) {
    if (!this.tpl) return null;
    const { w, h } = this.size;
    this.cx = w / 2 + (this.cx - w / 2) * k; this.cy = h / 2 + (this.cy - h / 2) * k;
    this.bw = Math.min(1, this.bw * k); this.bh = Math.min(1, this.bh * k);
    const b = this.box();
    this.tpl = null;      // re-initialise on the next frame at the new scale
    return b;
  }

  reset() { this.tpl = null; this.misses = 0; }
}
