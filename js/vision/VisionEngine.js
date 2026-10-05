import { Emitter } from '../util/events.js';
import { FrameSampler } from './FrameSampler.js';
import { PerformanceGovernor } from './PerformanceGovernor.js';

/**
 * Layer 1: real-time computer vision. Runs the local models on the live
 * stream on an adaptive schedule and emits structured frame analysis.
 *
 * Emits 'analysis' with:
 * {
 *   t, width, height, frame,
 *   people: [{ landmarks, world }],        // normalised pose landmarks (33 each)
 *   faces: [{ box, score, keypoints }],
 *   objects: [{ label, score, box }],
 *   sceneLabels: [{ label, score }],
 *   pixels: ImageData | null,              // small frame for lighting analysis
 *   perf: { tier, thermal, inferenceMs }
 * }
 * Stages that did not run this frame keep their previous result.
 */
export class VisionEngine extends Emitter {
  constructor(backend, video) {
    super();
    this.backend = backend;
    this.video = video;
    this.sampler = new FrameSampler();
    this.governor = new PerformanceGovernor();
    this.running = false;
    this.frame = 0;
    this.last = { people: [], faces: [], objects: [], sceneLabels: [], pixels: null };
    this.lastT = 0;
    this.enabled = { pose: true, face: true, objects: true, scene: true, lighting: true };
    this.failures = {};
    this._raf = 0;
    /** Returns the visible crop of the video frame; set by the app. */
    this.cropProvider = () => ({ x: 0, y: 0, w: 1, h: 1 });
    this.status = 'idle';
  }

  async load(onProgress = () => {}) {
    this.status = 'loading';
    onProgress('Loading pose model…');
    await this.backend.ensurePose();
    onProgress('Loading face model…');
    await this.backend.ensureFace();
    this.status = 'ready';
    // Heavier scene/object models load in the background; stages skip until ready.
    (async () => {
      try { await this.backend.ensureScene(); } catch (e) { console.warn('[vision] scene model unavailable', e); this.enabled.scene = false; }
      try { await this.backend.ensureObjects(); } catch (e) { console.warn('[vision] object model unavailable', e); this.enabled.objects = false; }
    })();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (now) => {
      if (!this.running) return;
      this.tick(now);
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) this._raf = this.video.requestVideoFrameCallback(loop);
      else this._raf = requestAnimationFrame(loop);
    };
    loop(performance.now());
  }

  stop() {
    this.running = false;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) { try { this.video.cancelVideoFrameCallback(this._raf); } catch { /* noop */ } }
    cancelAnimationFrame(this._raf);
  }

  tick(now) {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2 || v.paused) return;
    const sched = this.governor.evaluate(now);
    const minGap = 1000 / sched.maxFps;
    if (now - this.lastT < minGap * 0.9) return;
    if (this.lastT) this.governor.recordFrameGap(now - this.lastT);
    this.lastT = now;
    this.frame++;
    const f = this.frame, w = v.videoWidth, h = v.videoHeight;
    const ran = { pose: false, face: false, objects: false, scene: false, lighting: false };
    const due = (n) => f === 1 || f % n === 0;   // every stage runs on the first frame
    const t0 = performance.now();
    // Each stage is isolated: one failing model never blocks the others. A stage
    // that keeps failing is switched off so the camera experience is unaffected.
    const run = (stage, fn) => {
      if (!this.enabled[stage] || !due(sched[stage])) return;
      try { fn(); ran[stage] = true; this.failures[stage] = 0; }
      catch (e) {
        this.failures[stage] = (this.failures[stage] || 0) + 1;
        console.error(`[vision] ${stage} failed`, e);
        if (this.failures[stage] >= 3) { this.enabled[stage] = false; console.warn(`[vision] ${stage} stage disabled after repeated failures`); }
        this.emit('error', { stage, error: e });
      }
    };
    run('pose', () => { this.last.people = this.backend.detectPoses(v, now); });
    run('face', () => { this.last.faces = this.backend.detectFaces(v, now, w, h); });
    run('objects', () => { this.last.objects = this.backend.detectObjects(v, now, w, h); });
    run('scene', () => { this.last.sceneLabels = this.backend.classifyScene(v, now); });
    run('lighting', () => { this.last.pixels = this.sampler.sample(v, this.governor.analysisWidth, this.cropProvider()); });
    const ms = performance.now() - t0;
    if (ran.pose) this.governor.recordInference(ms);
    this.emit('analysis', { t: now, width: w, height: h, frame: f, ran, ...this.last, perf: this.governor.stats, inferenceMs: ms });
  }
}
