import { FILTERS, LOOK_DEFAULTS } from '../config/defaults.js';

/**
 * Colour + depth pipeline used for the live preview, viewer, thumbnails and
 * exports. The same maths runs as a WebGL shader (GPU) and as plain JS (CPU
 * fallback and tests), so what you see in the viewfinder is what gets saved.
 *
 * Stages: view crop / mirror → portrait background blur (person mask) → look
 * (filter blended by strength, plus editor adjustments) → highlight warning.
 */

const NUM_KEYS = ['brightness', 'temperature', 'tint', 'contrast', 'curve', 'saturation', 'fade', 'lift', 'vignette', 'grain'];

/** Editor adjustments (all neutral by default). */
export const ADJUST_DEFAULTS = { light: 0, contrast: 0, warmth: 0, saturation: 0, vignette: 0 };

/**
 * Final shader parameters: the look blended toward neutral by `strength`
 * (0…1.5), then the editor adjustments on top (each −1…1).
 */
export function composeParams(lookId = 'natural', strength = 1, adjust = null) {
  const f = FILTERS.find((x) => x.id === lookId) || FILTERS[0];
  const look = { ...LOOK_DEFAULTS, ...f.params };
  const p = {};
  for (const k of NUM_KEYS) p[k] = LOOK_DEFAULTS[k] + (look[k] - LOOK_DEFAULTS[k]) * strength;
  p.shadows = look.shadows.map((v) => v * strength);
  p.highlights = look.highlights.map((v) => v * strength);
  if (adjust) {
    const a = { ...ADJUST_DEFAULTS, ...adjust };
    p.brightness *= 1 + a.light * 0.45;
    p.lift += Math.max(0, a.light) * 0.08;
    p.contrast *= 1 + a.contrast * 0.4;
    p.temperature += a.warmth * 0.45;
    p.saturation *= 1 + a.saturation * 0.7;
    p.vignette = Math.min(1, p.vignette + Math.max(0, a.vignette) * 0.7);
  }
  return p;
}

/** Back-compat helper: parameters for a look at full strength. */
export function lookParams(id) { return composeParams(id, 1); }

const VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uTex, uMask, uBg;
uniform vec4 uCrop;
uniform vec2 uBgTexel;
uniform float uMirror, uBrightness, uTemp, uTint, uContrast, uCurve, uSat, uFade, uLift, uVignette, uGrain, uSeed, uDepth, uZebra;
uniform vec3 uShadows, uHighlights;
const vec3 W = vec3(0.2126, 0.7152, 0.0722);
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
void main() {
  vec2 uv = vUv;
  vec2 s = vec2(uMirror > 0.5 ? 1.0 - uv.x : uv.x, uv.y);
  vec3 o = texture2D(uTex, uCrop.xy + s * uCrop.zw).rgb;
  if (uDepth > 0.001) {
    float m = smoothstep(0.25, 0.75, texture2D(uMask, s).r);
    vec2 d = uBgTexel * 1.5;
    vec3 b = texture2D(uBg, s).rgb * 0.2
      + (texture2D(uBg, s + vec2(d.x, 0.0)).rgb + texture2D(uBg, s - vec2(d.x, 0.0)).rgb + texture2D(uBg, s + vec2(0.0, d.y)).rgb + texture2D(uBg, s - vec2(0.0, d.y)).rgb) * 0.125
      + (texture2D(uBg, s + d).rgb + texture2D(uBg, s - d).rgb + texture2D(uBg, s + vec2(d.x, -d.y)).rgb + texture2D(uBg, s + vec2(-d.x, d.y)).rgb) * 0.075;
    o = mix(o, b, (1.0 - m) * min(1.0, uDepth * 4.0));
  }
  vec3 c = o * uBrightness;
  c *= vec3(1.0 + uTemp * 0.35, 1.0 + uTemp * 0.04 - uTint * 0.3, 1.0 - uTemp * 0.35);
  c = c + uLift * (1.0 - c) * (1.0 - c);
  c = (c - 0.5) * uContrast + 0.5;
  vec3 cc = clamp(c, 0.0, 1.0);
  c = mix(c, cc * cc * (3.0 - 2.0 * cc), uCurve);
  float l = dot(c, W);
  c = mix(vec3(l), c, uSat);
  float l2 = clamp(dot(c, W), 0.0, 1.0);
  c += uShadows * (1.0 - l2) + uHighlights * l2;
  c = c * (1.0 - uFade) + uFade;
  float r = length(uv - 0.5) * 1.41421;
  c *= 1.0 - uVignette * smoothstep(0.35, 1.0, r);
  c += (hash(uv * 1024.0) - 0.5) * uGrain;
  c = clamp(c, 0.0, 1.0);
  if (uZebra > 0.5 && dot(c, W) > 0.965) {
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 14.0 + uSeed));
    c = mix(c, vec3(1.0, 0.25, 0.2), stripe * 0.85);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

/** CPU version of the look stage for one pixel (components 0..1). Kept in lock-step with FS. */
export function shadePixel(r, g, b, u, v, p, noise = 0) {
  let c0 = r * p.brightness, c1 = g * p.brightness, c2 = b * p.brightness;
  c0 *= 1 + p.temperature * 0.35; c1 *= 1 + p.temperature * 0.04 - p.tint * 0.3; c2 *= 1 - p.temperature * 0.35;
  c0 += p.lift * (1 - c0) * (1 - c0); c1 += p.lift * (1 - c1) * (1 - c1); c2 += p.lift * (1 - c2) * (1 - c2);
  c0 = (c0 - 0.5) * p.contrast + 0.5; c1 = (c1 - 0.5) * p.contrast + 0.5; c2 = (c2 - 0.5) * p.contrast + 0.5;
  const sm = (x) => { const k = x < 0 ? 0 : x > 1 ? 1 : x; return k * k * (3 - 2 * k); };
  c0 += (sm(c0) - c0) * p.curve; c1 += (sm(c1) - c1) * p.curve; c2 += (sm(c2) - c2) * p.curve;
  const l = 0.2126 * c0 + 0.7152 * c1 + 0.0722 * c2;
  c0 = l + (c0 - l) * p.saturation; c1 = l + (c1 - l) * p.saturation; c2 = l + (c2 - l) * p.saturation;
  let l2 = 0.2126 * c0 + 0.7152 * c1 + 0.0722 * c2; l2 = l2 < 0 ? 0 : l2 > 1 ? 1 : l2;
  c0 += p.shadows[0] * (1 - l2) + p.highlights[0] * l2; c1 += p.shadows[1] * (1 - l2) + p.highlights[1] * l2; c2 += p.shadows[2] * (1 - l2) + p.highlights[2] * l2;
  c0 = c0 * (1 - p.fade) + p.fade; c1 = c1 * (1 - p.fade) + p.fade; c2 = c2 * (1 - p.fade) + p.fade;
  const rr = Math.hypot(u - 0.5, v - 0.5) * 1.41421;
  const t = Math.min(1, Math.max(0, (rr - 0.35) / 0.65)); const vig = 1 - p.vignette * t * t * (3 - 2 * t);
  c0 *= vig; c1 *= vig; c2 *= vig;
  const n = noise * p.grain; c0 += n; c1 += n; c2 += n;
  const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  return [cl(c0), cl(c1), cl(c2)];
}

/** Apply look parameters to ImageData in place on the CPU. */
export function applyLookCPU(img, params) {
  const { data, width: w, height: h } = img;
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const out = shadePixel(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, (x + 0.5) / w, v, params, params.grain ? rnd() : 0);
      data[i] = out[0] * 255; data[i + 1] = out[1] * 255; data[i + 2] = out[2] * 255;
    }
  }
  return img;
}

/** Background size for a blur amount (0…1): the smaller, the blurrier. */
export function blurBackgroundWidth(amount) { const k = 1 - Math.min(1, Math.max(0, amount)); return Math.round(36 + k * k * 300); }

/**
 * Smooth downscale of a source region into a small canvas (repeated halving
 * avoids aliasing). Used as the blurred background for Portrait mode.
 */
export function downscale(source, sx, sy, sw, sh, tw, out = document.createElement('canvas')) {
  const th = Math.max(2, Math.round(tw * (sh / sw)));
  let cw = sw, ch = sh, cur = source, cx = sx, cy = sy;
  const tmp = [document.createElement('canvas'), document.createElement('canvas')]; let k = 0;
  while (cw / 2 > tw) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = tmp[k]; c.width = nw; c.height = nh;
    c.getContext('2d').drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    cur = c; cx = 0; cy = 0; cw = nw; ch = nh; k ^= 1;
  }
  out.width = tw; out.height = th;
  const ctx = out.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, cx, cy, cw, ch, 0, 0, tw, th);
  return out;
}

/** Grey mask canvas from segmenter output {data, width, height}. */
export function maskToCanvas(mask, out = document.createElement('canvas')) {
  out.width = mask.width; out.height = mask.height;
  const ctx = out.getContext('2d'); const img = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) { const v = mask.data[i]; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return out;
}

export class LookRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, { preserveDrawingBuffer = false } = {}) {
    this.canvas = canvas; this.ok = false;
    try {
      const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer, powerPreference: 'high-performance' });
      if (!gl) return;
      this.gl = gl;
      const prog = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
        const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        gl.attachShader(prog, sh);
      }
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const mkTex = (unit) => {
        const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([255]));
        return t;
      };
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.tex = mkTex(0); this.maskTex = mkTex(1); this.bgTex = mkTex(2);
      this.u = {};
      for (const n of ['uTex', 'uMask', 'uBg', 'uCrop', 'uBgTexel', 'uMirror', 'uBrightness', 'uTemp', 'uTint', 'uContrast', 'uCurve', 'uSat', 'uFade', 'uLift', 'uVignette', 'uGrain', 'uSeed', 'uShadows', 'uHighlights', 'uDepth', 'uZebra']) this.u[n] = gl.getUniformLocation(prog, n);
      gl.uniform1i(this.u.uTex, 0); gl.uniform1i(this.u.uMask, 1); gl.uniform1i(this.u.uBg, 2);
      this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      this.bgSize = [1, 1];
      this.ok = true;
    } catch (e) {
      console.warn('[render] WebGL unavailable, using fallback', e);
      this.ok = false;
    }
  }

  /** Person mask: {data, width, height} from the segmenter, or a grey canvas/bitmap. */
  setMask(mask) {
    if (!this.ok || !mask) return;
    const gl = this.gl; gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    if (mask.data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, mask.width, mask.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, mask.data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, mask);
  }

  /** Small, already-blurred background image (see downscale). */
  setBackground(canvas) {
    if (!this.ok || !canvas) return;
    const gl = this.gl; gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, canvas);
    this.bgSize = [canvas.width, canvas.height];
  }

  /**
   * Draw `source` (video, image, canvas, bitmap) into the canvas.
   * @param o.crop normalised source rect; o.mirror flips horizontally; o.depth 0…1 portrait blur
   *        (needs setMask/setBackground); o.zebra shows clipped highlights.
   */
  draw(source, { crop = { x: 0, y: 0, w: 1, h: 1 }, mirror = false, params = composeParams(), seed = 0, depth = 0, zebra = false } = {}) {
    if (!this.ok) return false;
    const gl = this.gl, u = this.u;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source); } catch { return false; }
    gl.uniform4f(u.uCrop, crop.x, crop.y, crop.w, crop.h);
    gl.uniform2f(u.uBgTexel, 1 / this.bgSize[0], 1 / this.bgSize[1]);
    gl.uniform1f(u.uMirror, mirror ? 1 : 0);
    gl.uniform1f(u.uBrightness, params.brightness); gl.uniform1f(u.uTemp, params.temperature); gl.uniform1f(u.uTint, params.tint);
    gl.uniform1f(u.uContrast, params.contrast); gl.uniform1f(u.uCurve, params.curve); gl.uniform1f(u.uSat, params.saturation);
    gl.uniform1f(u.uFade, params.fade); gl.uniform1f(u.uLift, params.lift); gl.uniform1f(u.uVignette, params.vignette);
    gl.uniform1f(u.uGrain, params.grain); gl.uniform1f(u.uSeed, seed);
    gl.uniform3fv(u.uShadows, params.shadows); gl.uniform3fv(u.uHighlights, params.highlights);
    gl.uniform1f(u.uDepth, depth); gl.uniform1f(u.uZebra, zebra ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}

let exporter = null;

/**
 * Render a still (ImageBitmap / canvas / image) with a look, editor adjustments
 * and optional portrait blur into a new canvas. GPU when possible, CPU otherwise.
 * @param o.depth { mask: canvas|bitmap (grey, any size), amount: 0…1 }
 */
export function renderStill(source, { lookId = 'natural', strength = 1, adjust = null, maxSide = 0, depth = null } = {}) {
  const sw = source.width, sh = source.height;
  const scale = maxSide ? Math.min(1, maxSide / Math.max(sw, sh)) : 1;
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const params = composeParams(lookId, strength, adjust);
  const neutralLook = (lookId === 'natural' || strength === 0) && !hasAdjust(adjust);
  const amount = depth?.mask ? depth.amount ?? 0 : 0;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const ctx = out.getContext('2d', { alpha: false });
  if (neutralLook && amount <= 0) { ctx.drawImage(source, 0, 0, w, h); return out; }
  const bg = amount > 0 ? downscale(source, 0, 0, sw, sh, blurBackgroundWidth(amount)) : null;
  if (!exporter) exporter = new LookRenderer(document.createElement('canvas'), { preserveDrawingBuffer: true });
  if (exporter.ok && Math.max(sw, sh) <= exporter.maxTexture && w <= exporter.maxTexture && h <= exporter.maxTexture) {
    exporter.canvas.width = w; exporter.canvas.height = h;
    if (amount > 0) { exporter.setMask(depth.mask); exporter.setBackground(bg); }
    if (exporter.draw(source, { params, depth: amount })) { ctx.drawImage(exporter.canvas, 0, 0); return out; }
  }
  // CPU fallback: composite blur with 2D canvas, then the look per pixel.
  ctx.drawImage(source, 0, 0, w, h);
  if (amount > 0) {
    const fg = document.createElement('canvas'); fg.width = w; fg.height = h;
    const fctx = fg.getContext('2d'); fctx.drawImage(source, 0, 0, w, h);
    const alpha = document.createElement('canvas'); alpha.width = w; alpha.height = h;
    const actx = alpha.getContext('2d'); actx.drawImage(depth.mask, 0, 0, w, h);
    const a = actx.getImageData(0, 0, w, h); for (let i = 0; i < a.data.length; i += 4) { const m = a.data[i] / 255; const t = Math.min(1, Math.max(0, (m - 0.25) / 0.5)); a.data[i + 3] = 255 * t * t * (3 - 2 * t); }
    actx.putImageData(a, 0, 0);
    fctx.globalCompositeOperation = 'destination-in'; fctx.drawImage(alpha, 0, 0);
    ctx.drawImage(bg, 0, 0, w, h); ctx.drawImage(fg, 0, 0);
  }
  if (!neutralLook) { const img = ctx.getImageData(0, 0, w, h); ctx.putImageData(applyLookCPU(img, params), 0, 0); }
  return out;
}

function hasAdjust(a) { return !!a && Object.keys(ADJUST_DEFAULTS).some((k) => Math.abs(a[k] || 0) > 1e-3); }

/** Strong CSS approximation for browsers without WebGL (live preview only). */
export function cssFallback(id, strength = 1) {
  const f = FILTERS.find((x) => x.id === id) || FILTERS[0];
  if (f.css === 'none' || strength <= 0) return 'none';
  return f.css;
}
