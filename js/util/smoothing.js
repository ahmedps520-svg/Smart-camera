/** Exponential moving average for scalars. */
export class EMA {
  constructor(alpha = 0.3, initial = null) { this.alpha = alpha; this.value = initial; }
  push(v) { this.value = this.value == null ? v : this.value + this.alpha * (v - this.value); return this.value; }
  reset(v = null) { this.value = v; }
}

/** EMA over an object of numeric fields (e.g. a box {x,y,w,h}). */
export class EMAVector {
  constructor(alpha = 0.3) { this.alpha = alpha; this.value = null; }
  push(v) {
    if (!v) return this.value;
    if (!this.value) { this.value = { ...v }; return this.value; }
    for (const k of Object.keys(v)) {
      if (typeof v[k] === 'number') this.value[k] = this.value[k] + this.alpha * (v[k] - (this.value[k] ?? v[k]));
    }
    return this.value;
  }
  reset() { this.value = null; }
}

/**
 * One Euro filter: low lag when moving fast, strong smoothing when still.
 * Used for the composition box so it tracks the subject without jitter.
 */
export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.015, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = null;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  push(v, t) {
    if (this.x == null || this.t == null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const dxRaw = (v - this.x) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    this.dx = this.dx + aD * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuro.alpha(cutoff, dt);
    this.x = this.x + a * (v - this.x);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
}

export class OneEuroBox {
  constructor(opts) { this.f = { x: new OneEuro(opts), y: new OneEuro(opts), w: new OneEuro(opts), h: new OneEuro(opts) }; }
  push(b, t) { return b ? { x: this.f.x.push(b.x, t), y: this.f.y.push(b.y, t), w: this.f.w.push(b.w, t), h: this.f.h.push(b.h, t) } : null; }
  reset() { Object.values(this.f).forEach((f) => f.reset()); }
}

/** Fixed-size ring buffer with mean/variance helpers. */
export class Ring {
  constructor(size) { this.size = size; this.buf = []; }
  push(v) { this.buf.push(v); if (this.buf.length > this.size) this.buf.shift(); return v; }
  get length() { return this.buf.length; }
  mean() { return this.buf.length ? this.buf.reduce((s, v) => s + v, 0) / this.buf.length : 0; }
  max() { return this.buf.length ? Math.max(...this.buf) : 0; }
  variance() { const m = this.mean(); return this.buf.length ? this.buf.reduce((s, v) => s + (v - m) ** 2, 0) / this.buf.length : 0; }
  clear() { this.buf = []; }
}
