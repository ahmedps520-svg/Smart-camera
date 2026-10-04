import { MODELS } from '../config/defaults.js';

/**
 * Vision backend built on MediaPipe Tasks (WASM + WebGL), fully local.
 * Models are loaded from the app's own origin; no network is needed once the
 * service worker has cached them. Each task is created lazily and can be
 * swapped by changing MODELS in config/defaults.js.
 *
 * Any other backend (e.g. TF.js MoveNet, ONNX Runtime Web) can replace this
 * class as long as it implements the same four methods.
 */
export class MediaPipeBackend {
  constructor(models = MODELS) {
    this.models = models;
    this.lib = null;
    this.fileset = null;
    this.pose = null; this.face = null; this.objects = null; this.scene = null;
    this.delegate = models.runtime.delegate;
    this.lastTs = { pose: -1, face: -1, objects: -1, scene: -1 };
    this.ready = false;
  }

  static url(rel) { return new URL(rel, document.baseURI).href; }

  async init() {
    if (this.ready) return;
    this.lib = await import(new URL(this.models.runtime.bundle, import.meta.url).href);
    this.fileset = {
      wasmLoaderPath: MediaPipeBackend.url(this.models.runtime.wasmLoaderPath),
      wasmBinaryPath: MediaPipeBackend.url(this.models.runtime.wasmBinaryPath),
    };
    this.ready = true;
  }

  async createWithFallback(factory, opts, delegate = this.delegate) {
    try { return await factory({ ...opts, baseOptions: { ...opts.baseOptions, delegate } }); }
    catch (e) {
      if (delegate === 'GPU') {
        console.warn('[vision] GPU delegate failed, falling back to CPU', e);
        if (delegate === this.delegate) this.delegate = 'CPU';
        return factory({ ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } });
      }
      throw e;
    }
  }

  async ensurePose() {
    if (this.pose) return this.pose;
    await this.init();
    const m = this.models.pose;
    this.pose = await this.createWithFallback((o) => this.lib.PoseLandmarker.createFromOptions(this.fileset, o), {
      baseOptions: { modelAssetPath: MediaPipeBackend.url(m.path) },
      runningMode: 'VIDEO', numPoses: m.numPoses,
      minPoseDetectionConfidence: m.minDetection, minPosePresenceConfidence: m.minPresence, minTrackingConfidence: m.minTracking,
      outputSegmentationMasks: false,
    });
    return this.pose;
  }

  async ensureFace() {
    if (this.face) return this.face;
    await this.init();
    const m = this.models.face;
    this.face = await this.createWithFallback((o) => this.lib.FaceDetector.createFromOptions(this.fileset, o), {
      baseOptions: { modelAssetPath: MediaPipeBackend.url(m.path) }, runningMode: 'VIDEO', minDetectionConfidence: m.minDetection,
    });
    return this.face;
  }

  async ensureObjects() {
    if (this.objects) return this.objects;
    await this.init();
    const m = this.models.objects;
    this.objects = await this.createWithFallback((o) => this.lib.ObjectDetector.createFromOptions(this.fileset, o), {
      baseOptions: { modelAssetPath: MediaPipeBackend.url(m.path) }, runningMode: 'VIDEO', maxResults: m.maxResults, scoreThreshold: m.scoreThreshold,
    }, m.delegate || this.delegate);
    return this.objects;
  }

  async ensureScene() {
    if (this.scene) return this.scene;
    await this.init();
    const m = this.models.scene;
    this.scene = await this.createWithFallback((o) => this.lib.ImageClassifier.createFromOptions(this.fileset, o), {
      baseOptions: { modelAssetPath: MediaPipeBackend.url(m.path) }, runningMode: 'VIDEO', maxResults: m.maxResults, scoreThreshold: m.scoreThreshold,
    }, m.delegate || this.delegate);
    return this.scene;
  }

  ts(key, t) { const v = Math.max(Math.floor(t), this.lastTs[key] + 1); this.lastTs[key] = v; return v; }

  /** → [{ landmarks: [{x,y,z,visibility}], world: [...] }] normalised to the source frame. */
  detectPoses(source, t) {
    if (!this.pose) return [];
    const r = this.pose.detectForVideo(source, this.ts('pose', t));
    return (r.landmarks || []).map((lm, i) => ({ landmarks: lm, world: r.worldLandmarks?.[i] || null }));
  }

  /** → [{ box:{x,y,w,h} normalised, score, keypoints:[{x,y}] }] */
  detectFaces(source, t, w, h) {
    if (!this.face) return [];
    const r = this.face.detectForVideo(source, this.ts('face', t));
    return (r.detections || []).map((d) => ({
      box: { x: d.boundingBox.originX / w, y: d.boundingBox.originY / h, w: d.boundingBox.width / w, h: d.boundingBox.height / h },
      score: d.categories?.[0]?.score ?? 0,
      keypoints: (d.keypoints || []).map((k) => ({ x: k.x, y: k.y })),
    }));
  }

  /** → [{ label, score, box }] */
  detectObjects(source, t, w, h) {
    if (!this.objects) return [];
    const r = this.objects.detectForVideo(source, this.ts('objects', t));
    return (r.detections || []).map((d) => ({
      label: d.categories?.[0]?.categoryName || 'object', score: d.categories?.[0]?.score ?? 0,
      box: { x: d.boundingBox.originX / w, y: d.boundingBox.originY / h, w: d.boundingBox.width / w, h: d.boundingBox.height / h },
    }));
  }

  /** → [{ label, score }] ImageNet-style labels, mapped to scenes by SceneClassifier. */
  classifyScene(source, t) {
    if (!this.scene) return [];
    const r = this.scene.classifyForVideo(source, this.ts('scene', t));
    return (r.classifications?.[0]?.categories || []).map((c) => ({ label: c.categoryName, score: c.score }));
  }

  close() {
    for (const k of ['pose', 'face', 'objects', 'scene']) { try { this[k]?.close(); } catch { /* noop */ } this[k] = null; }
  }
}
