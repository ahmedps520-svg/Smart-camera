import { Emitter } from '../util/events.js';
import { clamp } from '../util/math.js';
import { LensModel } from './LensModel.js';

/**
 * Owns the MediaStream, the <video> element, zoom (hardware + digital), torch,
 * exposure compensation, focus point and full-resolution capture.
 *
 * Events: 'started' {facing, width, height}, 'stopped', 'zoom' {zoom, digital}, 'error'
 */
export class CameraController extends Emitter {
  constructor(video) {
    super();
    this.video = video;
    this.stream = null;
    this.track = null;
    this.facing = 'environment';
    this.lens = new LensModel();
    this.zoom = 1;
    this.digitalZoom = 1;        // portion of zoom applied as a crop (CSS transform + capture crop)
    this.capabilities = {};
    this.devices = [];
    this.imageCapture = null;
    this.deviceId = null;
    this.mirror = false;
  }

  static isSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

  async start({ facing = 'environment', deviceId = null } = {}) {
    await this.stop();
    this.facing = facing;
    const base = {
      width: { ideal: 4096 }, height: { ideal: 3072 }, frameRate: { ideal: 30, max: 60 },
    };
    const constraints = {
      audio: false,
      video: deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: facing } },
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: facing } });
      } else throw e;
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.deviceId = this.track.getSettings().deviceId || deviceId;
    this.capabilities = (this.track.getCapabilities && this.track.getCapabilities()) || {};
    const settings = this.track.getSettings();
    if (settings.facingMode) this.facing = settings.facingMode === 'user' ? 'user' : 'environment';
    this.mirror = this.facing === 'user';
    try { this.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { this.devices = []; }
    this.lens.update({ devices: this.devices, facing: this.facing, capabilities: this.capabilities });
    this.imageCapture = (typeof ImageCapture !== 'undefined') ? new ImageCapture(this.track) : null;
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    await this.waitForFrame();
    this.track.addEventListener('ended', () => this.emit('stopped'));
    this.setZoom(1, { silent: true });
    this.emit('started', { facing: this.facing, width: this.video.videoWidth, height: this.video.videoHeight, lens: this.lens.describe() });
    return this;
  }

  waitForFrame() {
    return new Promise((resolve) => {
      if (this.video.readyState >= 2 && this.video.videoWidth) return resolve();
      const done = () => { this.video.removeEventListener('loadeddata', done); resolve(); };
      this.video.addEventListener('loadeddata', done);
      setTimeout(resolve, 2500);
    });
  }

  async stop() {
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; this.track = null; }
    this.video.srcObject = null;
  }

  get isRunning() { return !!this.track && this.track.readyState === 'live'; }
  get width() { return this.video.videoWidth || 0; }
  get height() { return this.video.videoHeight || 0; }

  async flip() {
    return this.start({ facing: this.facing === 'user' ? 'environment' : 'user' });
  }

  /** Switch to a specific physical camera (e.g. ultra wide) by deviceId. */
  async switchDevice(deviceId) { return this.start({ facing: this.facing, deviceId }); }

  /**
   * Set zoom factor. Uses hardware zoom where the track supports it, and applies
   * the remainder as a digital crop (CSS scale on the preview, crop on capture).
   */
  async setZoom(factor, { silent = false } = {}) {
    const lens = this.lens;
    factor = clamp(factor, lens.minZoom, lens.maxZoom);
    let hw = 1, digital = factor;
    if (lens.hardware) {
      hw = clamp(factor, lens.hardware.min, lens.hardware.max);
      digital = factor / hw;
      try { await this.track.applyConstraints({ advanced: [{ zoom: hw }] }); }
      catch { digital = factor; }
    }
    if (factor < 1 && !lens.hardware) digital = 1; // can't go wider without an ultra-wide track
    this.zoom = factor;
    this.digitalZoom = Math.max(1, digital);
    this.applyVideoTransform();
    if (!silent) this.emit('zoom', { zoom: this.zoom, digital: this.digitalZoom > 1.001 });
    return this.zoom;
  }

  /** CSS transform for the raw <video> (only visible when the WebGL preview is unavailable). */
  applyVideoTransform() { this.video.style.transform = `${this.mirror ? 'scaleX(-1) ' : ''}scale(${this.digitalZoom})`; }

  /**
   * Normalised source rectangle shown in a view of size viewW×viewH:
   * object-fit: cover, then the digital zoom as a centred crop.
   */
  static cropFor(srcW, srcH, viewW, viewH, digitalZoom = 1) {
    if (!srcW || !srcH || !viewW || !viewH) return { x: 0, y: 0, w: 1, h: 1 };
    const va = viewW / viewH, sa = srcW / srcH;
    let w = 1, h = 1;
    if (sa > va) w = va / sa; else h = sa / va;
    w /= digitalZoom; h /= digitalZoom;
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }

  /** Crop of the live video frame that is visible in a view of the given size. */
  viewCrop(viewW, viewH) { return CameraController.cropFor(this.video.videoWidth, this.video.videoHeight, viewW, viewH, this.digitalZoom); }

  get supportsTorch() { return !!this.capabilities.torch; }
  async setTorch(on) {
    if (!this.supportsTorch) return false;
    try { await this.track.applyConstraints({ advanced: [{ torch: !!on }] }); return true; } catch { return false; }
  }

  get supportsExposure() { return !!this.capabilities.exposureCompensation; }
  async setExposureCompensation(ev) {
    if (!this.supportsExposure) return false;
    const c = this.capabilities.exposureCompensation;
    const v = clamp(ev, c.min, c.max);
    try { await this.track.applyConstraints({ advanced: [{ exposureMode: 'continuous', exposureCompensation: v }] }); return true; } catch { return false; }
  }

  /** Focus/expose at a normalised point (0..1) when the platform allows it. */
  async focusAt(nx, ny) {
    const adv = {};
    const caps = this.capabilities;
    if (caps.focusMode?.includes('single-shot') || caps.focusMode?.includes('continuous')) adv.focusMode = caps.focusMode.includes('single-shot') ? 'single-shot' : 'continuous';
    if (caps.pointsOfInterest) adv.pointsOfInterest = [{ x: nx, y: ny }];
    if (!Object.keys(adv).length) return false;
    try { await this.track.applyConstraints({ advanced: [adv] }); return true; } catch { return false; }
  }

  /**
   * Capture a full-resolution still of exactly what the viewfinder shows.
   * Prefers ImageCapture.takePhoto (real photo pipeline, Chrome/Android) and
   * falls back to the current video frame at the stream's native resolution
   * (Safari). The view crop and digital zoom are applied, and the image is
   * mirrored when the preview is. Returns {blob, width, height, canvas}.
   */
  async capture({ viewW, viewH, mirrorOutput = false, quality = 0.95 } = {}) {
    let source = null;
    if (this.imageCapture) {
      try {
        const blob = await this.imageCapture.takePhoto();
        source = await createImageBitmap(blob);
      } catch { source = null; }
    }
    const srcW = source ? source.width : this.video.videoWidth;
    const srcH = source ? source.height : this.video.videoHeight;
    const c = CameraController.cropFor(srcW, srcH, viewW || srcW, viewH || srcH, this.digitalZoom);
    const cw = Math.round(c.w * srcW), ch = Math.round(c.h * srcH);
    const sx = Math.round(c.x * srcW), sy = Math.round(c.y * srcH);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (mirrorOutput) { ctx.translate(cw, 0); ctx.scale(-1, 1); }
    ctx.drawImage(source || this.video, sx, sy, cw, ch, 0, 0, cw, ch);
    source?.close?.();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    return { blob, width: cw, height: ch, canvas };
  }
}
