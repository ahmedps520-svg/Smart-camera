import { FILTERS, LOOK_DEFAULTS } from '../config/defaults.js';

/**
 * Colour pipeline used for the live preview, review, thumbnails and exports.
 * The same maths runs as a WebGL shader (GPU) and as plain JS (CPU fallback and
 * tests), so what you see in the viewfinder is exactly what gets saved.
 *
 * The renderer also performs the view crop (object-fit: cover + digital zoom)
 * and mirroring, so preview and capture always frame the same area.
 */

export function lookParams(id) {
  const f = FILTERS.find((x) => x.id === id) || FILTERS[0];
  return { ...LOOK_DEFAULTS, ...f.params };
}

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
uniform sampler2D uTex;
uniform vec4 uCrop;
uniform float uMirror, uBrightness, uTemp, uTint, uContrast, uCurve, uSat, uFade, uLift, uVignette, uGrain, uStrength, uSeed;
uniform vec3 uShadows, uHighlights;
const vec3 W = vec3(0.2126, 0.7152, 0.0722);
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
void main() {
  vec2 uv = vUv;
  vec2 s = vec2(uMirror > 0.5 ? 1.0 - uv.x : uv.x, uv.y);
  vec3 o = texture2D(uTex, uCrop.xy + s * uCrop.zw).rgb;
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
  gl_FragColor = vec4(clamp(mix(o, c, uStrength), 0.0, 1.0), 1.0);
}`;

/** CPU version of the shader for one pixel (components 0..1). Kept in lock-step with FS. */
export function shadePixel(r, g, b, u, v, p, strength = 1, noise = 0) {
  const o0 = r, o1 = g, o2 = b;
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
  const mix = (a, x) => { const y = a + (x - a) * strength; return y < 0 ? 0 : y > 1 ? 1 : y; };
  return [mix(o0, c0), mix(o1, c1), mix(o2, c2)];
}

/** Apply a look to ImageData in place on the CPU. */
export function applyLookCPU(img, params, strength = 1) {
  const { data, width: w, height: h } = img;
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const out = shadePixel(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, (x + 0.5) / w, v, params, strength, params.grain ? rnd() : 0);
      data[i] = out[0] * 255; data[i + 1] = out[1] * 255; data[i + 2] = out[2] * 255;
    }
  }
  return img;
}

export class LookRenderer {
  /** @param {HTMLCanvasElement|OffscreenCanvas} canvas */
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
      this.prog = prog;
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.u = {};
      for (const n of ['uTex', 'uCrop', 'uMirror', 'uBrightness', 'uTemp', 'uTint', 'uContrast', 'uCurve', 'uSat', 'uFade', 'uLift', 'uVignette', 'uGrain', 'uStrength', 'uSeed', 'uShadows', 'uHighlights']) this.u[n] = gl.getUniformLocation(prog, n);
      this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      this.ok = true;
    } catch (e) {
      console.warn('[render] WebGL unavailable, using fallback', e);
      this.ok = false;
    }
  }

  /**
   * Draw `source` (video, image, canvas, bitmap) into the canvas.
   * @param crop normalised source rect {x,y,w,h}; mirror flips horizontally.
   */
  draw(source, { crop = { x: 0, y: 0, w: 1, h: 1 }, mirror = false, params = lookParams('natural'), strength = 1, seed = 0 } = {}) {
    if (!this.ok) return false;
    const gl = this.gl, u = this.u;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source); } catch { return false; }
    gl.uniform1i(u.uTex, 0);
    gl.uniform4f(u.uCrop, crop.x, crop.y, crop.w, crop.h);
    gl.uniform1f(u.uMirror, mirror ? 1 : 0);
    gl.uniform1f(u.uBrightness, params.brightness); gl.uniform1f(u.uTemp, params.temperature); gl.uniform1f(u.uTint, params.tint);
    gl.uniform1f(u.uContrast, params.contrast); gl.uniform1f(u.uCurve, params.curve); gl.uniform1f(u.uSat, params.saturation);
    gl.uniform1f(u.uFade, params.fade); gl.uniform1f(u.uLift, params.lift); gl.uniform1f(u.uVignette, params.vignette);
    gl.uniform1f(u.uGrain, params.grain); gl.uniform1f(u.uStrength, strength); gl.uniform1f(u.uSeed, seed);
    gl.uniform3fv(u.uShadows, params.shadows); gl.uniform3fv(u.uHighlights, params.highlights);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}

let exporter = null;

/**
 * Render a still (ImageBitmap / canvas / image) with a look into a new canvas.
 * GPU when possible, CPU otherwise. maxSide limits the output size (0 = full).
 */
export function renderStill(source, { lookId = 'natural', strength = 1, maxSide = 0 } = {}) {
  const sw = source.width, sh = source.height;
  const scale = maxSide ? Math.min(1, maxSide / Math.max(sw, sh)) : 1;
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const params = lookParams(lookId);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const ctx = out.getContext('2d', { alpha: false });
  if (lookId === 'natural' || strength === 0) { ctx.drawImage(source, 0, 0, w, h); return out; }
  if (!exporter) exporter = new LookRenderer(document.createElement('canvas'), { preserveDrawingBuffer: true });
  if (exporter.ok && Math.max(sw, sh) <= exporter.maxTexture && w <= exporter.maxTexture && h <= exporter.maxTexture) {
    exporter.canvas.width = w; exporter.canvas.height = h;
    if (exporter.draw(source, { params, strength })) { ctx.drawImage(exporter.canvas, 0, 0); return out; }
  }
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  ctx.putImageData(applyLookCPU(img, params, strength), 0, 0);
  return out;
}

/** Strong CSS approximation for browsers without WebGL (live preview only). */
export function cssFallback(id, strength = 1) {
  const f = FILTERS.find((x) => x.id === id) || FILTERS[0];
  if (f.css === 'none' || strength <= 0) return 'none';
  return strength >= 0.99 ? f.css : `${f.css} opacity(1)`;
}
