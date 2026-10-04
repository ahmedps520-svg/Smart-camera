export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const deg = (rad) => (rad * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;
export const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
export const variance = (arr) => { const m = mean(arr); return mean(arr.map((v) => (v - m) ** 2)); };
/** Score 1 when |v| <= tol, decaying linearly to 0 at |v| >= tol * falloff. */
export const toleranceScore = (v, tol, falloff = 4) => {
  const a = Math.abs(v);
  if (a <= tol) return 1;
  return clamp01(1 - (a - tol) / (tol * (falloff - 1)));
};
/** Score 1 at target, linear falloff to 0 at ±range. */
export const targetScore = (v, target, range) => clamp01(1 - Math.abs(v - target) / range);
export const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
export const unionBox = (boxes) => {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
export const boxCenter = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
