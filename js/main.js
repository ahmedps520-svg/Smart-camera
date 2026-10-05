/**
 * Smart Camera — application wiring (MVVM-style: this file is the view model
 * that connects camera, vision, analysis, reasoning, capture, library and UI).
 * Everything runs on-device; there is no network code in the app at all.
 */
import { OVERALL, COMPOSITION, SMART_PHOTO } from './config/defaults.js';
import { Settings } from './settings/Settings.js';
import { CameraController } from './camera/CameraController.js';
import { MotionSensor } from './motion/MotionSensor.js';
import { MediaPipeBackend } from './vision/MediaPipeBackend.js';
import { VisionEngine } from './vision/VisionEngine.js';
import { transformAnalysis } from './vision/ViewTransform.js';
import { SubjectTracker } from './analysis/SubjectTracker.js';
import { PoseScorer } from './analysis/PoseScorer.js';
import { CompositionEngine } from './analysis/CompositionEngine.js';
import { LightingAnalyzer } from './analysis/LightingAnalyzer.js';
import { ZoomAdvisor } from './analysis/ZoomAdvisor.js';
import { SceneClassifier } from './analysis/SceneClassifier.js';
import { FilterRecommender } from './analysis/FilterRecommender.js';
import { GroupAnalyzer } from './analysis/GroupAnalyzer.js';
import { PhotographyReasoner } from './reasoning/PhotographyReasoner.js';
import { AutoCaptureController } from './capture/AutoCaptureController.js';
import { PhotoProcessor } from './capture/PhotoProcessor.js';
import { PhotoLibrary } from './library/PhotoLibrary.js';
import { LookRenderer, composeParams, cssFallback, downscale, blurBackgroundWidth, maskToCanvas } from './render/LookRenderer.js';
import { summarizeExpressions, minEyesOpen, expressionNear } from './analysis/Expressions.js';
import { HoldTrigger, handRaised, isSmiling } from './capture/Triggers.js';
import { BurstSelector, sharpness } from './capture/BurstSelector.js';
import { HistogramView } from './ui/Histogram.js';
import { Overlay } from './ui/Overlay.js';
import { Controls } from './ui/Controls.js';
import { ReviewView } from './ui/ReviewView.js';
import { LibraryView } from './ui/LibraryView.js';
import { Haptics } from './ui/Haptics.js';
import { Toast } from './ui/Toast.js';
import { Sounds } from './ui/Sounds.js';
import { clamp01 } from './util/math.js';

const $ = (id) => document.getElementById(id);
const BLOCKER_TEXT = { pose: 'pose', framing: 'framing', stability: 'hold still', lighting: 'more light', overall: 'overall score', group: 'everyone still', 'same pose': 'new pose for another shot', eyes: 'eyes open' };

class SmartCameraApp {
  constructor() {
    this.settings = new Settings();
    this.video = $('video');
    this.viewport = $('viewport');
    this.camera = new CameraController(this.video);
    this.motion = new MotionSensor({ levelToleranceDeg: COMPOSITION.levelToleranceDeg, hysteresisDeg: COMPOSITION.hysteresisDeg });
    this.backend = new MediaPipeBackend();
    this.vision = new VisionEngine(this.backend, this.video);
    this.vision.cropProvider = () => this.viewCrop();
    this.tracker = new SubjectTracker();
    this.poseScorer = new PoseScorer();
    this.composition = new CompositionEngine();
    this.lighting = new LightingAnalyzer();
    this.zoomAdvisor = new ZoomAdvisor();
    this.sceneClassifier = new SceneClassifier();
    this.filterRecommender = new FilterRecommender();
    this.groupAnalyzer = new GroupAnalyzer();
    this.reasoner = new PhotographyReasoner();
    // Smart Photo uses a calmer coach: wider dead zone, longer hold, one instruction at a time.
    this.photoReasoner = new PhotographyReasoner(undefined, { enter: SMART_PHOTO.enterRatio, exit: SMART_PHOTO.exitRatio, minHoldMs: SMART_PHOTO.minHoldMs, confirmMs: SMART_PHOTO.confirmMs });
    this.autoCapture = new AutoCaptureController();
    this.processor = new PhotoProcessor();
    this.library = new PhotoLibrary();
    this.toast = new Toast($('toast'));
    this.sounds = new Sounds();
    this.controls = new Controls(this.settings);
    this.overlay = new Overlay($('overlay'), this.video);
    this.review = new ReviewView(this.library, this.toast);
    this.libraryView = new LibraryView(this.library);
    this.previewCanvas = $('preview');
    this.renderer = new LookRenderer(this.previewCanvas);
    if (this.renderer.ok) $('app').classList.add('gpu');
    this.state = { tracked: null, composition: null, lighting: null, scene: 'outdoor', scores: null, rec: null, aligned: false, holdProgress: 0, zoomAdvice: null, filterRec: null, autoState: 'IDLE' };
    this.capturing = false; this.visionReady = false; this.started = false; this.switching = false;
    this.histogram = new HistogramView($('histogram'));
    this.handTrigger = new HoldTrigger({ holdMs: 500, cooldownMs: 6000 });
    this.smileTrigger = new HoldTrigger({ holdMs: 350, cooldownMs: 4000 });
    this.portraitReady = false; this.expressionsReady = false; this.maskCoverage = 0; this.expressions = [];
    this.bursting = false;
    this.fps = { frames: 0, last: performance.now(), value: 0 };
  }

  get selfie() { return this.camera.facing === 'user'; }

  // ---------------------------------------------------------------- boot
  async boot() {
    this.registerServiceWorker();
    this.bindUI();
    this.applySettings();
    this.layoutViewport();
    // iOS: stop page pinch/double-tap zoom so pinch only zooms the camera.
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    const gate = $('gate'), text = $('gateText');
    if (!window.isSecureContext) { gate.dataset.error = 'true'; text.textContent = 'Camera access needs a secure (https) page. Open the GitHub Pages URL or localhost.'; $('gateStart').disabled = true; return; }
    if (!CameraController.isSupported()) { gate.dataset.error = 'true'; text.textContent = 'This browser does not support camera access (getUserMedia).'; $('gateStart').disabled = true; return; }
    $('gateStart').addEventListener('click', () => this.start());
    navigator.permissions?.query?.({ name: 'camera' }).then((p) => { if (p.state === 'granted') $('gateFine').textContent = 'Camera access granted. Tap to open.'; }).catch(() => {});
  }

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // When a new version takes over, reload once so the new code runs straight away.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded || this.capturing) return;
      reloaded = true; location.reload();
    });
    window.addEventListener('load', async () => {
      try { const reg = await navigator.serviceWorker.register('./sw.js'); reg.update().catch(() => {}); }
      catch (e) { console.warn('SW registration failed', e); }
    });
  }

  async start() {
    const btn = $('gateStart'); btn.disabled = true; btn.textContent = 'Opening…';
    try {
      await this.motion.start();               // gesture-bound permission on iOS
      this.sounds.ensure();
      await this.camera.start({ facing: this.settings.get('facing') });
    } catch (e) {
      const gate = $('gate'); gate.dataset.error = 'true';
      $('gateText').textContent = e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access for this site in your browser settings, then try again.' : e.name === 'NotFoundError' ? 'No camera was found on this device.' : `Could not open the camera: ${e.message}`;
      btn.disabled = false; btn.textContent = 'Try again';
      return;
    }
    $('gate').hidden = true; this.started = true;
    this.onCameraStarted();
    this.startPreviewLoop();
    this.loadVision();
    document.addEventListener('visibilitychange', () => this.onVisibility());
    const relayout = () => { this.layoutViewport(); };
    window.addEventListener('resize', relayout);
    window.visualViewport?.addEventListener('resize', relayout);
    screen.orientation?.addEventListener?.('change', () => setTimeout(relayout, 150));
    this.library.count().then((n) => this.refreshThumb(n)).catch(() => {});
  }

  async loadVision() {
    this.controls.setAI({ enabled: this.settings.get('aiEnabled'), busy: true });
    this.controls.setGuide({ code: 'LOAD', text: 'Loading on-device models', tone: 'neutral' });
    try {
      await this.vision.load((msg) => this.controls.setGuide({ code: 'LOAD', text: msg, tone: 'neutral' }));
      this.visionReady = true;
      this.vision.on('analysis', (a) => this.onAnalysis(a));
      this.vision.on('error', () => {});
      this.syncVisionRunning();
      this.syncOptionalStages();
      this.controls.setAI({ enabled: this.settings.get('aiEnabled'), busy: false });
      $('aboutCaps').textContent = `Vision runtime: MediaPipe Tasks (${this.backend.delegate} delegate). Preview: ${this.renderer.ok ? 'GPU (WebGL)' : 'CSS fallback'}. ${this.camera.lens.describe()}. Motion sensors: ${this.motion.available ? 'available' : 'unavailable'}.`;
    } catch (e) {
      console.error(e);
      this.controls.setAI({ enabled: false, busy: false });
      this.controls.setGuide({ code: 'ERR', text: 'AI unavailable — camera still works', tone: 'bad' });
      this.toast.show(`Could not load the vision models (${e.message}). Capture still works.`, 5000);
      this.settings.set('aiEnabled', false);
    }
  }

  // ---------------------------------------------------------------- viewfinder
  /** Size the viewfinder for the chosen photo shape (full screen, 4:3 or 16:9). */
  /**
   * Some iOS versions draw web apps under the status bar without reporting a
   * safe-area inset. Detect that (full-screen height, zero inset) and push the
   * top bar down so it is never under the clock or the blurred status-bar edge.
   */
  adjustTopInset() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    const envTop = probe.getBoundingClientRect().height; probe.remove();
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const portrait = window.innerHeight > window.innerWidth;
    const underStatusBar = portrait && Math.abs(window.innerHeight - screen.height) <= 2;
    if (isIOS && envTop < 20 && underStatusBar) document.documentElement.style.setProperty('--top-extra', '62px');
    else document.documentElement.style.removeProperty('--top-extra');
  }

  layoutViewport() {
    this.adjustTopInset();
    const aspect = this.settings.get('aspect');
    const W = window.innerWidth, H = window.innerHeight;
    const st = this.viewport.style;
    if (aspect === 'full') { st.top = '0px'; st.bottom = '0px'; st.left = '0px'; st.right = '0px'; st.height = ''; st.width = ''; }
    else {
      const [a, b] = aspect.split(':').map(Number);
      const portrait = H >= W;
      const ratio = portrait ? a / b : b / a;     // height / width in portrait, width / height in landscape
      if (portrait) {
        const h = Math.min(H, Math.round(W * ratio));
        const topBar = this.viewport.offsetParent ? document.getElementById('topbar').getBoundingClientRect().bottom : 0;
        const top = Math.max(0, Math.min(Math.round(topBar), Math.round((H - h) / 2)));
        st.left = '0px'; st.right = '0px'; st.width = ''; st.top = `${top}px`; st.height = `${h}px`; st.bottom = 'auto';
      } else {
        const w = Math.min(W, Math.round(H / ratio));
        st.top = '0px'; st.bottom = '0px'; st.height = ''; st.left = `${Math.round((W - w) / 2)}px`; st.width = `${w}px`; st.right = 'auto';
      }
    }
    this.overlay.resize();
    // Tell the overlay where the toolbars are so labels never sit underneath them.
    const vr = this.viewport.getBoundingClientRect();
    const tb = $('topbar').getBoundingClientRect(), bb = document.querySelector('.bottombar').getBoundingClientRect();
    this.overlay.topInset = Math.max(0, tb.bottom - vr.top) + 44;
    this.overlay.bottomInset = bb.width < vr.width * 0.6 ? 16 : Math.max(0, vr.bottom - bb.top) + 8;
    this.sizePreviewCanvas();
  }

  viewSize() { const r = this.viewport.getBoundingClientRect(); return { w: r.width || window.innerWidth, h: r.height || window.innerHeight }; }
  viewCrop() { const { w, h } = this.viewSize(); return this.camera.viewCrop(w, h); }

  sizePreviewCanvas() {
    if (!this.renderer.ok) return;
    const { w, h } = this.viewSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (this.previewCanvas.width !== cw || this.previewCanvas.height !== ch) { this.previewCanvas.width = cw; this.previewCanvas.height = ch; }
  }

  /**
   * Preview loop: draws every new camera frame with crop, mirror, look, live
   * portrait blur and highlight warning (GPU), and feeds the histogram.
   */
  startPreviewLoop() {
    const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    const bgCanvas = document.createElement('canvas');
    let lastMask = null, n = 0;
    this.depthLive = 0;
    const frame = () => {
      if (this.video.readyState >= 2 && this.video.videoWidth && !document.hidden) {
        const s = this.settings; const crop = this.viewCrop(); n++;
        if (s.get('histogram')) this.histogram.update(this.video, crop);
        if (this.renderer.ok) {
          // Portrait: blur fades in only when a person mask is available.
          const mask = this.vision.last.mask;
          const wantDepth = s.get('mode') === 'portrait' && this.portraitReady && mask && this.maskCoverage > 0.03 ? Math.max(0.05, s.get('portraitBlur')) : 0;
          this.depthLive += (wantDepth - this.depthLive) * 0.15;
          if (this.depthLive > 0.01) {
            if (mask !== lastMask) { this.renderer.setMask(mask); lastMask = mask; }
            if (n % 2 === 0 || !this._bgReady) {
              const vw = this.video.videoWidth, vh = this.video.videoHeight;
              downscale(this.video, crop.x * vw, crop.y * vh, crop.w * vw, crop.h * vh, blurBackgroundWidth(Math.max(this.depthLive, 0.2)), bgCanvas);
              this.renderer.setBackground(bgCanvas); this._bgReady = true;
            }
          }
          const ok = this.renderer.draw(this.video, { crop, mirror: this.camera.mirror, params: composeParams(s.get('filter'), s.get('filterStrength')), seed: (performance.now() % 1000) / 1000, depth: this.depthLive > 0.01 ? this.depthLive : 0, zebra: s.get('zebra') });
          if (!ok) { this.renderer.ok = false; $('app').classList.remove('gpu'); this.applyPreviewFallback(); }
        }
      }
      if (useRVFC) this.video.requestVideoFrameCallback(frame); else requestAnimationFrame(frame);
    };
    if (useRVFC) this.video.requestVideoFrameCallback(frame); else requestAnimationFrame(frame);
  }

  applyPreviewFallback() {
    this.video.style.filter = this.renderer.ok ? 'none' : cssFallback(this.settings.get('filter'), this.settings.get('filterStrength'));
    this.camera.applyVideoTransform();
  }

  // ---------------------------------------------------------------- UI bindings
  bindUI() {
    const c = this.controls, s = this.settings;
    c.on('mode', (m) => { s.set('mode', m); Haptics.tap(); });
    c.on('shutter', () => this.capture({ auto: false }));
    c.on('burstStart', () => this.burstStart());
    c.on('burstEnd', () => this.burstEnd());
    c.on('flip', () => this.switchFacing(this.selfie ? 'environment' : 'user'));
    c.on('selfie', () => this.switchFacing(this.selfie ? 'environment' : 'user'));
    c.on('flash', (v) => { s.set('flash', v); Haptics.tap(); });
    c.on('timer', (v) => { s.set('timer', v); Haptics.tap(); });
    c.on('zoom', (z) => this.setZoom(z, true));
    c.on('lens', (id) => this.camera.switchDevice(id).then(() => this.onCameraStarted()).catch(() => this.toast.show('Could not switch lens')));
    c.on('focus', async ({ x, y, px, py }) => {
      c.focusRingAt(px, py);
      const crop = this.viewCrop(); const vx = this.camera.mirror ? 1 - x : x;
      await this.camera.focusAt(crop.x + vx * crop.w, crop.y + y * crop.h);
    });
    c.on('setting', ({ key, value }) => s.set(key, value));
    c.on('gallery', () => this.openLibrary());
    s.on('change', ({ key }) => this.applySettings(key));
    this.review.on('close', () => this.resumeAfterReview());
    this.review.on('retake', () => this.resumeAfterReview());
    this.libraryView.on('close', () => this.resumeAfterReview());
    this.libraryView.on('open', (rec) => { this.libraryView.hide(); this.review.show(rec); });
    this.review.on('grid', () => { this.vision.stop(); this.libraryView.show(); });
    this.review.on('deleted', async ({ remaining }) => this.refreshThumb(remaining));
    this.autoCapture.on('capture', () => this.capture({ auto: true }));
    this.autoCapture.on('state', ({ state, progress }) => this.onAutoState(state, progress));
    this.autoCapture.on('cancel', () => { this.sounds.cancel(); this.controls.setCountdown(null); });
    this.camera.on('zoom', ({ zoom }) => this.controls.setZoom(zoom, this.state.zoomAdvice?.zoom ?? null));
    this.camera.on('stopped', () => { if (this.started && !document.hidden && !this.switching) this.toast.show('Camera stopped'); });
  }

  async switchFacing(facing) {
    if (this.switching) return;
    this.switching = true; Haptics.tap();
    try {
      await this.camera.start({ facing });
      this.settings.set('facing', this.camera.facing);
      if (facing === 'user' && this.camera.facing !== 'user') this.toast.show('No front camera found');
      this.onCameraStarted();
    } catch {
      this.toast.show('Could not switch camera');
      try { await this.camera.start({ facing: facing === 'user' ? 'environment' : 'user' }); this.onCameraStarted(); } catch { /* leave gate */ }
    } finally { this.switching = false; }
  }

  applySettings(key) {
    const s = this.settings, c = this.controls;
    const mode = s.get('mode');
    c.setMode(mode);
    c.setFlash(s.get('flash'), this.camera.supportsTorch);
    c.setTimer(s.get('timer'));
    c.setSelfie(this.camera.isRunning ? this.selfie : s.get('facing') === 'user');
    c.setAI({ enabled: s.get('aiEnabled'), busy: !this.visionReady && s.get('aiEnabled') && this.started, thermal: this.vision.governor.thermal });
    c.setFilter(s.get('filter'), this.state.filterRec?.id);
    if (!this.renderer.ok) this.applyPreviewFallback();
    this.overlay.options.grid = s.get('grid'); this.overlay.options.horizon = s.get('horizon'); this.overlay.options.skeleton = s.get('skeleton');
    $('histogram').hidden = !s.get('histogram');
    c.setAperture(mode === 'portrait');
    if (key === 'portraitBlur' || key === undefined) { $('apertureSlider').value = s.get('portraitBlur'); c.setApertureLabel(s.get('portraitBlur')); }
    if (key === 'grid' || key === undefined) $('ctlGrid').value = s.get('grid');
    this.syncOptionalStages();
    this.sounds.enabled = s.get('sound'); Haptics.enabled = s.get('haptics');
    this.autoCapture.configure({ holdMs: s.get('holdMs'), thresholds: { overall: s.get('autoThreshold') } });
    this.vision.governor.setMode(s.get('rate'));
    if (key === 'aspect') { this.layoutViewport(); this.tracker.reset(); this.reasoner.reset(); this.photoReasoner.reset(); }
    if (key === 'mirrorFront' || key === undefined) { this.camera.mirror = this.camera.facing === 'user' && s.get('mirrorFront'); this.overlay.options.mirror = this.camera.mirror; if (this.camera.isRunning) this.camera.applyVideoTransform(); }
    if (key === 'exposure' && this.camera.isRunning) this.camera.setExposureCompensation(s.get('exposure')).then((ok) => { if (!ok) this.toast.show('Exposure control is not available on this camera'); });
    if (key === 'mode' || key === 'aiEnabled' || key === undefined) {
      this.reasoner.reset(); this.photoReasoner.reset(); this.autoCapture.setEnabled(mode === 'pose' && s.get('aiEnabled'));
      this.controls.setCountdown(null); this.controls.setArmed(false);
      this.syncVisionRunning();
      if (!s.get('aiEnabled') || mode === 'photo') { this.controls.setGuide(null); this.controls.setScores(null, false); this.controls.setScene(null, false); this.overlay.draw({ mode: 'photo', motion: this.motion.read(), now: performance.now() }); }
    }
  }

  /**
   * Optional models load on first use: person segmentation for Portrait, and the
   * face mesh (smile / blink) for the smile shutter, blink guard and bursts.
   */
  syncOptionalStages() {
    const s = this.settings, mode = s.get('mode'), ai = s.get('aiEnabled') && this.visionReady;
    const wantSegment = ai && mode === 'portrait';
    const wantExpr = ai && mode !== 'photo' && (s.get('smileTrigger') || (s.get('blinkGuard') && mode === 'pose') || this.bursting);
    const load = (flag, busyFlag, fn, label) => {
      if (this[flag] || this[busyFlag]) return;
      this[busyFlag] = true;
      fn().then(() => { this[flag] = true; this.syncOptionalStages(); })
        .catch((e) => { console.warn(e); this.toast.show(`${label} is not available on this device`); })
        .finally(() => { this[busyFlag] = false; });
    };
    if (wantSegment) load('portraitReady', '_loadingSeg', () => this.backend.ensureSegmenter(), 'Portrait mode');
    if (wantExpr) load('expressionsReady', '_loadingExpr', () => this.backend.ensureFaceMesh(), 'Smile and blink detection');
    this.vision.enabled.segment = wantSegment && this.portraitReady && (this.vision.failures.segment || 0) < 3;
    this.vision.enabled.expressions = wantExpr && this.expressionsReady && (this.vision.failures.expressions || 0) < 3;
    if (!this.vision.enabled.segment) { this.vision.last.mask = null; this.maskCoverage = 0; }
    if (!this.vision.enabled.expressions) { this.vision.last.expressions = []; this.expressions = []; }
  }

  syncVisionRunning() {
    const want = this.visionReady && this.started && this.settings.get('aiEnabled') && this.settings.get('mode') !== 'photo' && !document.hidden && this.camera.isRunning;
    if (want) this.vision.start(); else this.vision.stop();
  }

  onCameraStarted() {
    const s = this.settings;
    this.camera.mirror = this.camera.facing === 'user' && s.get('mirrorFront');
    this.overlay.options.mirror = this.camera.mirror;
    this.camera.setZoom(1, { silent: true });
    this.controls.setZoomPresets(this.camera.lens.presets(), 1, null);
    this.controls.setLenses(this.camera.lens.devices, this.camera.deviceId);
    this.controls.setFlash(s.get('flash'), this.camera.supportsTorch);
    this.controls.setSelfie(this.selfie);
    if (s.get('exposure')) this.camera.setExposureCompensation(s.get('exposure'));
    this.tracker.reset(); this.reasoner.reset(); this.photoReasoner.reset(); this.zoomAdvisor.current = null;
    this.layoutViewport();
    if (!this.renderer.ok) this.applyPreviewFallback();
    this.syncVisionRunning();
  }

  onVisibility() {
    if (document.hidden) { this.vision.stop(); this.camera.stop(); }
    else if (this.started) this.camera.start({ facing: this.camera.facing, deviceId: this.camera.deviceId }).then(() => this.onCameraStarted()).catch(() => {});
  }

  async setZoom(z, fromUser) {
    const applied = await this.camera.setZoom(z);
    if (fromUser) this.zoomAdvisor.current = null;
    return applied;
  }

  // ---------------------------------------------------------------- per-frame pipeline
  onAnalysis(a) {
    if (this.capturing && this.settings.get('mode') !== 'pose') return;
    const now = a.t; const s = this.settings; const mode = s.get('mode');
    this.fps.frames++; if (now - this.fps.last > 1000) { this.fps.value = this.fps.frames; this.fps.frames = 0; this.fps.last = now; this.controls.setPerf(`${this.fps.value} fps · ${a.perf.inferenceMs} ms · ${a.perf.tier}${a.perf.lowPower ? ' · low battery' : ''}`); this.controls.setAI({ enabled: true, busy: false, thermal: a.perf.thermal }); }
    const motion = this.motion.read();
    const selfie = this.selfie;

    // Layer 1 → structured data, in view coordinates (what the user actually sees).
    const crop = this.viewCrop();
    const view = transformAnalysis(a, crop);
    const exprs = this.vision.enabled.expressions ? summarizeExpressions(a.expressions, crop) : [];
    this.expressions = exprs;
    if (a.ran.segment && a.mask) {
      let on = 0, n = 0; for (let i = 0; i < a.mask.data.length; i += 7) { n++; if (a.mask.data[i] > 128) on++; }
      this.maskCoverage = n ? on / n : 0;
    }
    const tracked = this.tracker.update({ people: view.people, faces: view.faces, t: now });
    const lighting = a.ran.lighting ? this.lighting.analyze(a.pixels, tracked.primary, motion.stability) : this.lighting.last;
    if (a.frame === 1 || a.ran.scene || a.ran.objects || a.frame % 6 === 0) this.state.scene = this.sceneClassifier.update({ sceneLabels: a.sceneLabels, objects: view.objects, tracked, lighting }).scene;
    const scene = this.state.scene;
    const composition = this.composition.evaluate({ tracked, scene, motion, pixels: a.pixels, objects: view.objects, selfie });
    const pose = this.poseScorer.score(tracked.primary);
    const group = tracked.count > 1 ? this.groupAnalyzer.analyze(tracked) : null;
    const stability = Math.round(clamp01((motion.available ? motion.stability : 1) * 0.5 + (tracked.primary ? pose.components.stability ?? 1 : 1) * 0.5) * 100);
    const scores = { pose: tracked.primary ? pose.score : null, framing: composition.framingScore, lighting: lighting?.score ?? null, stability };
    const W = OVERALL.weights;
    scores.overall = Math.round(((scores.pose ?? composition.framingScore) * W.pose + scores.framing * W.framing + (scores.lighting ?? 70) * W.lighting + stability * W.stability) / (W.pose + W.framing + W.lighting + W.stability));
    const presets = this.camera.lens.presets();
    const zoomAdvice = this.zoomAdvisor.recommend({ composition, scene, presets, currentZoom: this.camera.zoom, tracked, now, allowZoom: !selfie });
    if (a.ran.lighting && (a.frame === 1 || a.frame % 12 === 0)) this.state.filterRec = this.filterRecommender.recommend({ lighting, scene });

    // Layer 2 → validated recommendation. Smart Photo freezes its instruction while the
    // phone is moving or the subject is momentarily lost, so it never flips mid-move.
    const smart = mode === 'smart' || mode === 'portrait';
    const freeze = smart && ((motion.available && motion.stability < SMART_PHOTO.freezeBelowStability) || !!tracked.coasting);
    const { stable: rec, raw } = (smart ? this.photoReasoner : this.reasoner).update({ mode: smart ? 'smart' : mode, scene, tracked, composition, pose, lighting, motion, zoom: { current: this.camera.zoom, presets, advice: zoomAdvice }, group, scores }, now, { freeze });
    this.vision.boost.objects = mode === 'smart' && tracked.count === 0 ? 8 : 0;
    const blocking = composition.issues.some((i) => i.severity >= 2) || (group?.issues.some((i) => i.severity >= 2) ?? false);
    const aligned = composition.hasSubject && !blocking && Math.hypot(composition.deviation.dx, composition.deviation.dy) <= COMPOSITION.tolerances.position * 1.3 && (motion.flat || Math.abs(motion.rollDeg) <= COMPOSITION.levelToleranceDeg * 3);

    // Auto capture (Smart Pose).
    let holdProgress = 0, blockers = [];
    if (mode === 'pose') {
      const eyesOpen = s.get('blinkGuard') && exprs.length ? minEyesOpen(exprs) : null;
      const st = this.autoCapture.update({ scores, subject: tracked.primary, group, now, eyesOpen });
      this.state.autoState = st;
      holdProgress = (st === 'HOLDING' || st === 'COUNTDOWN') ? this.autoCapture.progress : 0;
      blockers = st === 'MONITORING' ? this.autoCapture.blockers : [];
      this.controls.setArmed(st === 'HOLDING' || st === 'COUNTDOWN');
    }
    Object.assign(this.state, { tracked, composition, lighting, scores, rec, aligned, holdProgress, zoomAdvice, pose, group });

    // Hands-free triggers: raise a hand (3 s timer) or smile (instant).
    if (!this.capturing && !this.bursting) {
      if (this.handTrigger.update(s.get('handTrigger') && tracked.subjects.some(handRaised), now)) { this.smileTrigger.block(now); this.capture({ auto: true, timer: 3, trigger: 'hand' }); }
      else if (s.get('smileTrigger') && this.smileTrigger.update(isSmiling(expressionNear(exprs, tracked.primary?.head)), now)) { this.handTrigger.block(now); this.capture({ auto: true, trigger: 'smile' }); }
    }
    this.controls.setTrigger(this.handTrigger.progress > 0.2 && !this.capturing ? '✋ Hold your hand up…' : null);

    // UI.
    if (smart) { this.renderSmartPhoto({ rec, composition, tracked, motion, aligned, zoomAdvice, now, portrait: mode === 'portrait' }); return; }
    let guide = this.phrase(rec || (raw.recommendation !== 'NONE' ? raw : null));
    let sub = this.subline({ lighting, zoomAdvice, pose, tracked, mode, raw });
    if (mode === 'pose' && tracked.primary) {
      if (this.state.autoState === 'HOLDING') guide = { code: 'AUTO_HOLD', text: 'Hold it…', tone: 'good' };
      else if (this.state.autoState === 'COUNTDOWN') guide = { code: 'AUTO_COUNT', text: 'Perfect', tone: 'good' };
      else if (this.state.autoState === 'COOLDOWN') guide = { code: 'AUTO_DONE', text: 'Got it', tone: 'good' };
      else if (blockers.length) sub = `Auto capture needs: ${blockers.map((b) => BLOCKER_TEXT[b] || b).join(', ')}`;
    }
    this.controls.setGuide(guide, sub);
    this.controls.setScores(scores, mode === 'pose' && s.get('scores'), blockers);
    this.controls.setLevel(motion, s.get('horizon'));
    this.controls.setScene(scene, tracked.count === 0 && scene !== 'outdoor' && scene !== 'indoor');
    this.controls.setZoom(this.camera.zoom, zoomAdvice.action === 'ZOOM' ? zoomAdvice.zoom : null);
    if (this.state.filterRec && (a.frame === 1 || a.frame % 12 === 0)) this.controls.setFilter(s.get('filter'), this.state.filterRec.id);
    this.overlay.draw({ tracked, composition, motion, recommendation: rec, mode, aligned, holdProgress, now });
  }

  /**
   * Smart Photo UI: a yellow ring around the subject and one short instruction
   * beside it. No scores, no target box, no sub-lines.
   */
  renderSmartPhoto({ rec, composition, tracked, motion, aligned, zoomAdvice, now, portrait = false }) {
    const s = this.settings;
    const short = this.smartInstruction(rec);
    const perfect = !!rec && (rec.code === 'PERFECT' || rec.code === 'EVERYONE_IN_FRAME') && rec.captureReady && aligned;
    if (perfect && !this._wasPerfect) Haptics.tap();
    this._wasPerfect = perfect;
    const hasRing = !!composition.subjectBox;
    // Without a subject, only a level/horizon hint may appear (small, at the top).
    let top = !hasRing && short && (short.code === 'LEVEL_CAMERA' || short.code === 'TILT_UP' || short.code === 'TILT_DOWN') ? { ...short, tone: 'neutral' } : null;
    if (portrait) {
      if (!this.portraitReady) top = { code: 'PORTRAIT_LOAD', text: 'Preparing portrait…', tone: 'neutral' };
      else if (!tracked.primary || this.maskCoverage <= 0.03) top = { code: 'PORTRAIT_PERSON', text: 'Portrait works with people', tone: 'neutral' };
      else top = { code: 'PORTRAIT', text: 'Portrait', tone: 'good' };
    }
    this.controls.setGuide(top, '', { small: true });
    this.controls.setScores(null, false);
    this.controls.setScene(null, false);
    this.controls.setLevel(motion, s.get('horizon'));
    this.controls.setZoom(this.camera.zoom, null);   // zoom advice appears only as the ring's label
    this.overlay.draw({ mode: 'smart', motion, now, ring: hasRing ? { box: composition.subjectBox, coasting: !!tracked.coasting, perfect, label: perfect ? null : short, hideRing: portrait } : null });
  }

  /** Short, single instruction for Smart Photo (or null). */
  smartInstruction(rec) {
    if (!rec) return null;
    let code = rec.code, zoom = rec.zoom;
    if (code === 'SUBJECT_EDGE') code = rec.arrow === '←' ? 'MOVE_LEFT' : 'MOVE_RIGHT';
    else if (code === 'MORE_HEADROOM') code = 'TILT_UP';
    else if (code === 'LESS_HEADROOM') code = 'TILT_DOWN';
    else if (code === 'GROUP_EDGE') code = 'MOVE_BACK';
    const base = {
      MOVE_LEFT: ['Move left', '←'], MOVE_RIGHT: ['Move right', '→'], TILT_UP: ['Tilt up', '↑'], TILT_DOWN: ['Tilt down', '↓'],
      MOVE_CLOSER: ['Move closer', ''], MOVE_BACK: ['Step back', ''], LEVEL_CAMERA: ['Level the phone', ''], ZOOM: [zoom ? `Zoom ${zoom}×` : '', ''],
    }[code];
    if (!base || !base[0]) return null;
    return this.phrase({ code, text: base[0], arrow: base[1], tone: 'warn' });
  }

  /**
   * Wording. The reasoner's codes describe camera movement for the rear camera.
   * Selfies are phrased for someone holding the phone at arm's length; the
   * mirrored preview means "move left/right" already matches what the user sees.
   */
  phrase(rec) {
    if (!rec) return rec;
    if (this.selfie) {
      const t = { TILT_UP: ['Raise the phone', '↑'], TILT_DOWN: ['Lower the phone', '↓'], LESS_HEADROOM: ['Lower the phone', '↓'], MORE_HEADROOM: ['Raise the phone a little', '↑'], MOVE_CLOSER: ['Bring the phone closer', '↔'], MOVE_BACK: ['Hold the phone further away', '↔'], ZOOM: ['Bring the phone closer', '↔'] }[rec.code];
      let out = t ? { ...rec, text: t[0], arrow: t[1] } : rec;
      if (!this.camera.mirror && (rec.code === 'MOVE_LEFT' || rec.code === 'MOVE_RIGHT')) out = { ...out, arrow: rec.code === 'MOVE_LEFT' ? '→' : '←' };
      return out;
    }
    if (this.settings.get('direction') !== 'subject') return rec;
    const flip = { MOVE_LEFT: ['Subject right', '→'], MOVE_RIGHT: ['Subject left', '←'], TILT_UP: ['Subject down', '↓'], TILT_DOWN: ['Subject up', '↑'], LESS_HEADROOM: ['Subject up', '↑'] };
    const f = flip[rec.code]; if (!f) return rec;
    return { ...rec, text: f[0], arrow: f[1] };
  }

  subline({ lighting, zoomAdvice, pose, tracked, mode, raw }) {
    const bits = [];
    if (tracked.count > 1) bits.push(`${tracked.count} people`);
    if (lighting && raw.recommendation !== lighting.code && lighting.code !== 'LIGHT_GOOD') bits.push(lighting.advice);
    if (zoomAdvice.action === 'ZOOM' && raw.recommendation !== 'ZOOM') bits.push(`${zoomAdvice.zoom}× suggested`);
    if (mode === 'pose' && pose?.issues?.length && tracked.primary) bits.push(pose.issues[0]);
    return bits.slice(0, 2).join(' · ');
  }

  onAutoState(state, progress) {
    if (state === 'COUNTDOWN') { if (!progress) { this.sounds.ready(); Haptics.success(); } this.controls.setCountdown(progress ?? 0, 'Perfect'); }
    else if (state === 'HOLDING') { this.controls.setCountdown(null); }
    else { this.controls.setCountdown(null); this.controls.setArmed(false); }
  }

  // ---------------------------------------------------------------- capture
  /**
   * @param o.auto   true for hands-free captures (no review screen afterwards)
   * @param o.timer  seconds to count down (defaults to the timer setting for manual shots)
   * @param o.trigger 'pose' | 'hand' | 'smile' | null — recorded with the photo
   */
  async capture({ auto, timer = null, trigger = null }) {
    if (this.capturing || this.bursting || !this.camera.isRunning) return;
    this.capturing = true; this.controls.setBusy(true);
    try {
      const s = this.settings;
      const wait = timer ?? (auto ? 0 : s.get('timer'));
      if (wait > 0) await this.runTimer(wait);
      const flash = s.get('flash');
      const useTorch = this.camera.supportsTorch && (flash === 'on' || (flash === 'auto' && this.state.lighting?.isDark));
      if (useTorch) { await this.camera.setTorch(true); await new Promise((r) => setTimeout(r, 350)); }
      this.sounds.shutter(); Haptics.shutter(); this.controls.flashScreen();
      const { w, h } = this.viewSize();
      const shot = await this.camera.capture({ viewW: w, viewH: h, mirrorOutput: this.camera.mirror });
      if (useTorch) this.camera.setTorch(false);
      const record = await this.saveShot(shot, { auto, trigger: trigger || (auto ? 'pose' : null) });
      this.autoCapture.markCaptured(performance.now());
      this.handTrigger.block(performance.now(), 2500); this.smileTrigger.block(performance.now());
      this.controls.setCountdown(null);
      const label = { hand: 'Captured ✋', smile: 'Captured 😊' }[trigger] || 'Captured';
      if (auto) this.toast.show(label, 1400);
      else { this.vision.stop(); await this.review.show(record, { recommendedFilter: record.meta.filter, initialFilter: record.meta.look, strength: record.meta.strength }); }
    } catch (e) {
      console.error(e); this.toast.show(`Capture failed: ${e.message}`, 3000);
      this.autoCapture.markCaptured(performance.now());
    } finally { this.capturing = false; this.controls.setBusy(false); }
  }

  /**
   * Post-capture: portrait mask (kept with the photo so the blur stays adjustable),
   * full-resolution analysis, thumbnail, and save to the library.
   */
  async saveShot(shot, extraMeta = {}) {
    const s = this.settings;
    const look = s.get('filter'), strength = s.get('filterStrength');
    let maskBlob = null, maskCanvas = null;
    if (s.get('mode') === 'portrait' && this.portraitReady) {
      try {
        const k = 512 / Math.max(shot.width, shot.height);
        const small = document.createElement('canvas'); small.width = Math.round(shot.width * k); small.height = Math.round(shot.height * k);
        small.getContext('2d').drawImage(shot.canvas, 0, 0, small.width, small.height);
        const m = this.backend.segment(small, performance.now());
        if (m) {
          let on = 0; for (let i = 0; i < m.data.length; i += 5) if (m.data[i] > 128) on++;
          if (on / (m.data.length / 5) > 0.02) { maskCanvas = maskToCanvas(m); maskBlob = await new Promise((r) => maskCanvas.toBlob(r, 'image/png')); }
        }
      } catch (e) { console.warn('[portrait] still segmentation failed', e); }
    }
    const depth = maskCanvas ? { mask: maskCanvas, amount: s.get('portraitBlur') } : null;
    const context = { subject: this.state.tracked?.primary ? { box: this.state.tracked.primary.box } : null, scene: this.state.scene, look, strength, depth };
    const processed = await this.processor.process(shot, context);
    const record = await this.library.add({
      blob: shot.blob, thumb: processed.thumb, mask: maskBlob, width: shot.width, height: shot.height,
      meta: {
        scene: this.state.scene, scores: this.state.scores, lighting: { advice: processed.lighting.advice, score: processed.lighting.score }, filter: processed.filter.id,
        look, strength, zoom: this.camera.zoom, mode: s.get('mode'), selfie: this.selfie, composition: this.state.composition?.type,
        portrait: !!maskBlob, depth: maskBlob ? s.get('portraitBlur') : 0, depthDefault: maskBlob ? s.get('portraitBlur') : 0, ...extraMeta,
      },
    });
    this.refreshThumb(await this.library.count(), record);
    return record;
  }

  /**
   * Burst: while the shutter is held, grab frames (~8/s, up to 30) and keep only
   * the best one: sharpest, eyes open, best framing. Saved as a single photo.
   */
  burstStart() {
    if (this.capturing || this.bursting || !this.camera.isRunning) return;
    this.bursting = true; this.syncOptionalStages();
    const selector = new BurstSelector();
    const small = document.createElement('canvas'); small.width = 160; small.height = 160;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    const { w, h } = this.viewSize();
    this.controls.setBusy(true); Haptics.tap();
    const t0 = performance.now();
    const grab = () => {
      if (!this.bursting) return;
      const frame = this.camera.grabFrame({ viewW: w, viewH: h, mirrorOutput: this.camera.mirror });
      const k = 160 / Math.max(frame.width, frame.height); small.width = Math.round(frame.width * k); small.height = Math.round(frame.height * k);
      sctx.drawImage(frame, 0, 0, small.width, small.height);
      const sharp = sharpness(sctx.getImageData(0, 0, small.width, small.height));
      selector.offer({ sharp, eyesOpen: minEyesOpen(this.expressions), quality: this.state.scores?.overall ?? 70 }, () => frame);
      this.sounds.tick(); this.controls.flashScreen();
      this.controls.setTrigger(`Burst ${selector.frames}`);
      if (selector.frames >= 30 || performance.now() - t0 > 4500) { this.burstEnd(); return; }
      this._burstTimer = setTimeout(grab, 120);
    };
    this._burst = selector;
    grab();
  }

  async burstEnd() {
    if (!this.bursting) return;
    this.bursting = false; clearTimeout(this._burstTimer);
    const selector = this._burst; this._burst = null;
    this.controls.setTrigger(null); this.syncOptionalStages();
    if (!selector?.best?.payload) { this.controls.setBusy(false); return; }
    this.capturing = true;
    try {
      const canvas = selector.best.payload;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
      await this.saveShot({ blob, width: canvas.width, height: canvas.height, canvas }, { burst: selector.frames, trigger: 'burst' });
      Haptics.success();
      this.toast.show(selector.frames > 1 ? `Best of ${selector.frames} saved` : 'Saved', 1800);
    } catch (e) { console.error(e); this.toast.show('Burst failed'); }
    finally { this.capturing = false; this.controls.setBusy(false); }
  }

  runTimer(sec) {
    return new Promise((resolve) => {
      const start = performance.now(); const total = sec * 1000; let lastTick = -1;
      const step = () => { const p = Math.min(1, (performance.now() - start) / total); const left = Math.ceil(sec - p * sec); if (left !== lastTick) { lastTick = left; this.sounds.tick(); } this.controls.setCountdown(p, String(Math.max(1, left))); if (p >= 1) { this.controls.setCountdown(null); resolve(); } else requestAnimationFrame(step); };
      step();
    });
  }

  async refreshThumb(count, record) {
    const rec = record || (await this.library.latest());
    if (this._thumbUrl) URL.revokeObjectURL(this._thumbUrl);
    this._thumbUrl = rec ? URL.createObjectURL(rec.thumb || rec.blob) : null;
    this.controls.setThumb(this._thumbUrl, count);
  }

  /** Thumbnail tap: open the newest photo; swipe to browse the rest. */
  async openLibrary() {
    this.vision.stop();
    const ok = await this.review.show();
    if (!ok) this.syncVisionRunning();
  }
  resumeAfterReview() { this.tracker.reset(); this.reasoner.reset(); this.photoReasoner.reset(); this.syncVisionRunning(); }
}

const app = new SmartCameraApp();
window.smartCamera = app; // handy for debugging in Safari's Web Inspector
app.boot();
