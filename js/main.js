/**
 * Smart Camera — application wiring (MVVM-style: this file is the view model
 * that connects camera, vision, analysis, reasoning, capture, library and UI).
 * Everything runs on-device; there is no network code in the app at all.
 */
import { OVERALL, COMPOSITION, SMART_PHOTO, AI_STYLES } from './config/defaults.js';
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
import { LookRenderer, composeParams, cssFallback, downscale, blurBackgroundWidth, maskToCanvas, renderStill } from './render/LookRenderer.js';
import { summarizeExpressions, minEyesOpen, expressionNear } from './analysis/Expressions.js';
import { HoldTrigger, handRaised, isSmiling } from './capture/Triggers.js';
import { BurstSelector, sharpness } from './capture/BurstSelector.js';
import { HistogramView } from './ui/Histogram.js';
import { ShotFinder } from './ai/ShotFinder.js';
import { TemplateTracker, toGray } from './ai/TemplateTracker.js';
import { objectCandidates, peopleCandidates, saliencyCandidate } from './ai/Candidates.js';
import { focalLength } from './render/Frames.js';
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
    this.review = new ReviewView(this.library, this.toast, this.settings);
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
    // ✦ Find the shot
    this.finder = new ShotFinder();
    this.tTracker = new TemplateTracker();
    this._acquire = null;
    this.finder.on('acquire', ({ box }) => { this._acquire = { box, at: 0 }; Haptics.tap(); });
    this.finder.on('zoom', ({ zoom, from }) => {
      const pred = this.tTracker.zoomBy(zoom / from);
      this.setZoom(zoom, false);
      if (pred) this._acquire = { box: pred, at: performance.now() + 450 };
    });
    this.finder.on('capture', ({ label, box, head }) => { this.endFinderUI(); this.capture({ auto: true, trigger: 'ai', subject: label, focusY: head ? head.y + 0.06 : box ? box.y + box.h / 2 : null }); });
    this.finder.on('end', () => this.endFinderUI());
    this.fps = { frames: 0, last: performance.now(), value: 0 };
  }

  get selfie() { return this.camera.facing === 'user'; }

  /** Current AI style (Standard, Daily, Cinematic, Snapchat, Scenic, Street, Film). */
  get style() { return AI_STYLES.find((x) => x.id === this.settings.get('aiStyle')) || AI_STYLES[0]; }

  /** Look used for the preview and new photos: an explicit filter wins, otherwise the style's look. */
  effectiveLook() { const f = this.settings.get('filter'); return f && f !== 'natural' ? f : (this.style.look || 'natural'); }

  effectiveAspect() { return this.style.aspect || this.settings.get('aspect'); }

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
    this.controls.setStatus('Loading on-device AI…', 'gray');
    try {
      await this.vision.load(() => this.controls.setStatus('Loading on-device AI…', 'gray'));
      this.controls.setStatus(this.idleStatus(), 'gray');
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
      this.controls.setStatus('AI unavailable — the camera still works', 'gray');
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
    const aspect = this.effectiveAspect();
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
    const vb = this.viewport.getBoundingClientRect();
    document.documentElement.style.setProperty('--vf-bottom', `${Math.round(vb.bottom)}px`);
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
        // With the AI idle (plain camera), still draw the grid and level guide.
        if (!this.vision.running && n % 2 === 0) this.overlay.draw({ mode: 'photo', motion: this.motion.read(), now: performance.now() });
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
          const ok = this.renderer.draw(this.video, { crop, mirror: this.camera.mirror, params: composeParams(this.effectiveLook(), s.get('filterStrength'), this.softwareEV() ? { ev: this.softwareEV() } : null), seed: (performance.now() % 1000) / 1000, depth: this.depthLive > 0.01 ? this.depthLive : 0, zebra: s.get('zebra') });
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
    c.on('scan', () => this.toggleScan());
    c.on('styleStep', (d) => { const i = AI_STYLES.findIndex((x) => x.id === this.style.id); const n = AI_STYLES[(i + d + AI_STYLES.length) % AI_STYLES.length]; this.settings.set('aiStyle', n.id); });
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
    c.syncTopIcons({ grid: s.get('grid'), horizon: s.get('horizon') });
    $('app').dataset.aspect = this.effectiveAspect();
    this.overlay.options.letterbox = !!this.style.letterbox;
    c.setStyle(this.style.id, key === 'aiStyle');
    if (!this.finder.active && (key === 'mode' || key === undefined)) c.setStatus(this.idleStatus(), 'gray');
    if (key === 'portraitBlur' || key === undefined) { $('apertureSlider').value = s.get('portraitBlur'); c.setApertureLabel(s.get('portraitBlur')); }
    if (key === 'grid' || key === undefined) $('ctlGrid').value = s.get('grid');
    this.syncOptionalStages();
    this.sounds.enabled = s.get('sound'); Haptics.enabled = s.get('haptics');
    this.autoCapture.configure({ holdMs: s.get('holdMs'), thresholds: { overall: s.get('autoThreshold') } });
    this.vision.governor.setMode(s.get('rate'));
    if (key === 'aspect' || key === 'aiStyle') { this.layoutViewport(); this.tracker.reset(); this.reasoner.reset(); this.photoReasoner.reset(); }
    if (key === 'aiStyle') {
      if (this.finder.active) this.finder.cancel('style');
      if (this.camera.isRunning && Math.abs(this.camera.zoom - 1) > 0.01) this.setZoom(1, true);
      this.flashStatus(`${this.style.name} — ${this.style.tagline}`, 'yellow', 2200);
      Haptics.tap();
    }
    if (key === 'mirrorFront' || key === undefined) { this.camera.mirror = this.camera.facing === 'user' && s.get('mirrorFront'); this.overlay.options.mirror = this.camera.mirror; if (this.camera.isRunning) this.camera.applyVideoTransform(); }
    if (key === 'exposure' && this.camera.isRunning && this.camera.supportsExposure) this.camera.setExposureCompensation(s.get('exposure'));
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
    const want = this.visionReady && this.started && this.settings.get('aiEnabled') && (this.settings.get('mode') !== 'photo' || this.finder.active) && !document.hidden && this.camera.isRunning;
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
    if (this.finder.active) { this.state.lighting = lighting; this.state.scene = scene; this.runFinder({ a, view, tracked, lighting, scene, motion, now, selfie }); return; }
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

  // ---------------------------------------------------------------- ✦ Find the shot
  idleStatus() {
    return { photo: 'Tap ✦ to scan a new scene', smart: 'Smart guide · tap ✦ to find the shot', pose: 'Smart Pose · auto capture', portrait: 'Portrait · tap ✦ to find the shot' }[this.settings.get('mode')] || '';
  }

  flashStatus(text, tone = 'gray', ms = 3200) {
    clearTimeout(this._statusTimer);
    this.controls.setStatus(text, tone);
    this._statusTimer = setTimeout(() => { if (!this.finder.active) this.controls.setStatus(this.idleStatus(), 'gray'); }, ms);
  }

  toggleScan() {
    if (this.finder.active) { this.finder.cancel(); return; }
    if (this.capturing || this.bursting) return;
    if (!this.visionReady) { this.flashStatus('AI is still loading…'); return; }
    if (!this.settings.get('aiEnabled')) this.settings.set('aiEnabled', true);
    clearTimeout(this._statusTimer);
    this.tracker.reset(); this.tTracker.reset(); this._acquire = null;
    this.finder.start(performance.now(), this.style);
    $('finderText').textContent = this.style.scanText;
    this.vision.boost = { objects: 2, lighting: 1, scene: 15 };
    this.controls.setScan('active'); this.controls.setStatus('Finding your shot...', 'yellow');
    $('finderText').hidden = false; const cnt = $('finderCount'); cnt.hidden = false; cnt.textContent = '3';
    Haptics.tap();
    this.syncVisionRunning();
  }

  endFinderUI() {
    $('finderText').hidden = true; $('finderCount').hidden = true;
    this.controls.setScan('idle');
    this.vision.boost = {};
    this.tTracker.reset(); this._acquire = null;
    this.overlay.clear(); this.overlay.targetFilter.reset();
    clearTimeout(this._statusTimer); this.controls.setStatus(this.idleStatus(), 'gray');
    this.syncVisionRunning();
  }

  /** One analysed frame while Find the shot is active. */
  runFinder({ a, view, tracked, lighting, scene, motion, now, selfie }) {
    const f = this.finder;
    const scanning = f.state === 'SCANNING';
    this.vision.boost = { objects: scanning ? 2 : 5, lighting: 1, scene: 15 };
    const gray = a.ran.lighting && a.pixels ? toGray(a.pixels) : null;
    const cands = [...peopleCandidates(tracked, { selfie }), ...objectCandidates(view.objects)];
    if (a.pixels && (scanning || f.target?.kind === 'light')) { const sal = saliencyCandidate(a.pixels, { scene }); if (sal) cands.push(sal); }
    let track = null;
    if (gray) {
      if (this._acquire && now >= this._acquire.at) { this.tTracker.init(gray, this._acquire.box); this._acquire = null; }
      if (this.tTracker.active) {
        track = this.tTracker.update(gray);
        // Re-anchor on a fresh detection of the same subject (fixes template drift).
        const key = f.target?.key;
        // Light targets (sunset glow) re-anchor on the saliency map every frame: soft gradients
        // make template matching wander. Objects and people re-anchor on their detections.
        if (key && track && (f.target.kind === 'light' || a.ran.objects || a.ran.pose)) {
          const tc = { x: track.box.x + track.box.w / 2, y: track.box.y + track.box.h / 2 };
          const same = cands.filter((c) => c.key === key).map((c) => ({ c, d: Math.hypot(c.box.x + c.box.w / 2 - tc.x, c.box.y + c.box.h / 2 - tc.y) })).sort((p, q) => p.d - q.d)[0];
          if (same && same.d < (f.target.kind === 'light' ? 0.22 : 0.15)) { this.tTracker.init(gray, same.c.box); track = { box: same.c.box, confidence: 1, lost: false }; }
        }
      }
    }
    // People and groups: follow them with the pose tracker directly (robust on any texture).
    if (f.target && (f.target.kind === 'person' || f.target.kind === 'group')) {
      const tb = f.target.box, tc = { x: tb.x + tb.w / 2, y: tb.y + tb.h / 2 };
      const same = cands.filter((c) => c.key === f.target.key).map((c) => ({ c, d: Math.hypot(c.box.x + c.box.w / 2 - tc.x, c.box.y + c.box.h / 2 - tc.y) })).sort((p, q) => p.d - q.d)[0];
      if (same && same.d < 0.3) { track = { box: same.c.box, head: same.c.head, confidence: 1, lost: false }; if (gray) this.tTracker.init(gray, same.c.box); }
    }
    const vm = f.update({ candidates: cands, track, motion, zoom: { current: this.camera.zoom, presets: this.camera.lens.presets() }, lighting }, now);
    this.renderFinder(vm, motion, now);
  }

  renderFinder(vm, motion, now) {
    const c = this.controls;
    if (vm.state === 'IDLE' || vm.state === 'CAPTURE') {
      if (vm.message) this.flashStatus(vm.message, vm.tone === 'green' ? 'green' : 'gray');
      return;
    }
    const scanning = vm.state === 'SCANNING';
    $('finderText').hidden = !scanning;
    const cnt = $('finderCount'); cnt.hidden = !scanning;
    if (scanning && cnt.textContent !== String(vm.countdown)) { cnt.textContent = String(vm.countdown); cnt.classList.remove('tick'); void cnt.offsetWidth; cnt.classList.add('tick'); this.sounds.tick(); }
    if (vm.state === 'READY' && this._lastFinderState !== 'READY') Haptics.success();
    this._lastFinderState = vm.state;
    c.setStatus(vm.message || '', vm.tone);
    c.setScan(vm.state === 'READY' ? 'ready' : 'active');
    c.setGuide(null); c.setScores(null, false); c.setScene(null, false); c.setTrigger(null);
    c.setLevel(motion, this.settings.get('horizon'));
    c.setZoom(this.camera.zoom, null);
    this.overlay.draw({ finder: vm, motion, now, mode: 'finder' });
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
  async capture({ auto, timer = null, trigger = null, subject = null, focusY = null }) {
    if (this.capturing || this.bursting || !this.camera.isRunning) return;
    if (this.finder.active && trigger !== 'ai') this.finder.cancel('manual');
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
      let shot = await this.camera.capture({ viewW: w, viewH: h, mirrorOutput: this.camera.mirror });
      shot = await this.bakeExposure(shot);
      if (useTorch) this.camera.setTorch(false);
      // Where a later Cinema crop is centred: exactly the live guide band in Cinematic,
      // otherwise around the face (or the subject).
      const prim = this.state.tracked?.primary;
      const fy = this.style.letterbox ? 0.5 : (focusY ?? (prim?.head ? prim.head.y + 0.06 : prim ? prim.box.y + prim.box.h / 2 : 0.5));
      const record = await this.saveShot(shot, { auto, trigger: trigger || (auto ? 'pose' : null), subject, focusY: fy });
      this.autoCapture.markCaptured(performance.now());
      this.handTrigger.block(performance.now(), 2500); this.smileTrigger.block(performance.now());
      this.controls.setCountdown(null);
      const label = { hand: 'Captured ✋', smile: 'Captured 😊' }[trigger] || 'Captured';
      if (auto && trigger !== 'ai') this.toast.show(label, 1400);
      else {
        this.vision.stop();
        // AI shots open with the style's look (or the AI's recommendation in Standard).
        const initial = trigger === 'ai' && !this.style.look && this.settings.get('filter') === 'natural' ? record.meta.filter : record.meta.look;
        await this.review.show(record, { recommendedFilter: record.meta.filter, initialFilter: initial, strength: record.meta.strength });
      }
    } catch (e) {
      console.error(e); this.toast.show(`Capture failed: ${e.message}`, 3000);
      this.autoCapture.markCaptured(performance.now());
    } finally { this.capturing = false; this.controls.setBusy(false); }
  }

  /** Exposure time / ISO when the browser reports them (Chrome on Android does; Safari does not). */
  exposureInfo() {
    try {
      const st = this.camera.track?.getSettings?.() || {};
      const out = {};
      if (typeof st.exposureTime === 'number' && st.exposureTime > 0) out.exposureTime = st.exposureTime / 10000;   // spec unit: 100 µs
      if (typeof st.iso === 'number' && st.iso > 0) out.iso = st.iso;
      return out;
    } catch { return {}; }
  }

  /** Exposure compensation in software when the camera does not support it in hardware. */
  softwareEV() { const ev = this.settings.get('exposure') || 0; return !this.camera.supportsExposure && Math.abs(ev) > 0.01 ? ev : 0; }

  async bakeExposure(shot) {
    const ev = this.softwareEV(); if (!ev) return shot;
    const canvas = renderStill(shot.canvas, { adjust: { ev } });
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
    return { blob, width: canvas.width, height: canvas.height, canvas };
  }

  /**
   * Post-capture: portrait mask (kept with the photo so the blur stays adjustable),
   * full-resolution analysis, thumbnail, and save to the library.
   */
  async saveShot(shot, extraMeta = {}) {
    const s = this.settings;
    const look = this.effectiveLook(), strength = s.get('filterStrength');
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
        portrait: !!maskBlob, depth: maskBlob ? s.get('portraitBlur') : 0, depthDefault: maskBlob ? s.get('portraitBlur') : 0,
        focal: focalLength({ zoom: this.camera.zoom, selfie: this.selfie }), ...this.exposureInfo(), takenAt: Date.now(),
        style: this.style.id, ...(this.style.frame ? { frame: this.style.frame } : {}), ...extraMeta,
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
