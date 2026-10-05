/**
 * One-tap Auto-enhance: derives editor adjustments from a small sample of the
 * photo (exposure toward a pleasant mid-tone, contrast from the 2nd–98th
 * percentile spread, grey-world white balance, a little saturation for flat
 * images). Returns values in the editor's −1…1 ranges.
 */
export function autoEnhance(img) {
  const { data } = img; const n = data.length / 4;
  const hist = new Uint32Array(256);
  let r = 0, g = 0, b = 0, sat = 0, lum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    const L = Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B);
    hist[L]++; lum += L; r += R; g += G; b += B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B); sat += mx ? (mx - mn) / mx : 0;
  }
  const pct = (p) => { let acc = 0; const target = n * p; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; } return 1; };
  const lo = pct(0.02), hi = pct(0.98), mean = lum / n / 255;
  const clamp = (v, a = -1, z = 1) => Math.min(z, Math.max(a, v));
  const light = clamp((0.47 - mean) / 0.45 * 0.9, -0.5, 0.6);
  const spread = Math.max(0.05, hi - lo);
  const contrast = clamp((0.72 / spread - 1) * 0.8, -0.3, 0.5);
  const warmth = clamp(((b - r) / Math.max(1, (r + g + b) / 3)) * 1.4, -0.5, 0.5);
  const s = sat / n;
  const saturation = clamp(s < 0.25 ? (0.25 - s) * 2.5 : 0, 0, 0.45);
  const round = (v) => Math.round(v * 100) / 100;
  return { light: round(light), contrast: round(contrast), warmth: round(warmth), saturation: round(saturation), vignette: 0 };
}
