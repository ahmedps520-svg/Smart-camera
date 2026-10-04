/**
 * Smart Camera — application wiring (MVVM-style: this file is the view model
 * that connects camera, vision, analysis, reasoning, capture, library and UI).
 * Everything runs on-device; there is no network code in the app at all.
 */
import { AUTO_CAPTURE, OVERALL, COMPOSITION } from './config/defaults.js';
import { Settings } from './settings/Settings.js';
import { CameraController } from './camera/CameraController.js';
import { MotionSensor } from './motion/MotionSensor.js';
import { MediaPipeBackend } from './vision/MediaPipeBackend.js';
import { VisionEngine } from './vision/VisionEngine.js';
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
import { Overlay } from './ui/Overlay.js';
import { Controls } from './ui/Controls.js';
import { ReviewView } from './ui/ReviewView.js';
import { LibraryView } from './ui/LibraryView.js';
import { Haptics } from './ui/Haptics.js';
import { Toast } from './ui/Toast.js';
import { Sounds } from './ui/Sounds.js';
import { clamp01 } from './util/math.js';

const $ = (id) => document.getElementById(id);

class SmartCameraApp {
  constructor() {
    this.settings = new Settings();
    this.video = $('video');
    this.camera = new CameraController(this.video);
    this.motion = new MotionSensor({ levelToleranceDeg: COMPOSITION.levelToleranceDeg, hysteresisDeg: COMPOSITION.hysteresisDeg });
    this.backend = new MediaPipeBackend();
    this.vision = new VisionEngine(this.backend, this.video);
    this.tracker = new SubjectTracker();
    this.poseScorer = new PoseScorer();
    this.composition = new CompositionEngine();
    this.lighting = new LightingAnalyzer();
    this.zoomAdvisor = new ZoomAdvisor();
    this.sceneClassifier = new SceneClassifier();
    this.filterRecommender = new FilterRecommender();
    this.groupAnalyzer = new GroupAnalyzer();
    this.reasoner = new PhotographyReasoner();
    this.autoCapture = new AutoCaptureController();
    this.processor = new PhotoProcessor();
    this.library = new PhotoLibrary();
    this.toast = new Toast($('toast'));
    this.sounds = new Sounds();
    this.controls = new Controls(this.settings);
    this.overlay = new Overlay($('overlay'), this.video);
    this.review = new ReviewView(this.library, this.toast);
    this.libraryView = new LibraryView(this.library);
    this.state = { tracked: null, composition: null, lighting: null, scene: 'outdoor', scores: null, rec: null, aligned: false, holdProgress: 0, zoomAdvice: null, filterRec: null };
    this.capturing = false; this.visionReady = false; this.started = false;
    this.fps = { frames: 0, last: performance.now(), value: 0 };
  }

  // ---------------------------------------------------------------- boot
  async boot() {
    this.registerServiceWorker();
    this.bindUI();
    this.applySettings();
    const gate = $('gate'), text = $('gateText');
    if (!window.isSecureContext) { gate.dataset.error = 'true'; text.textContent = 'Camera access needs a secure (https) page. Open the GitHub Pages URL or localhost.'; $('gateStart').disabled = true; return; }
    if (!CameraController.isSupported()) { gate.dataset.error = 'true'; text.textContent = 'This browser does not support camera access (getUserMedia).'; $('gateStart').disabled = true; return; }
    $('gateStart').addEventListener('click', () => this.start());
    // Fast path: permission already granted → start on first interaction only (iOS needs a gesture for motion sensors anyway).
    navigator.permissions?.query?.({ name: 'camera' }).then((p) => { if (p.state === 'granted') $('gateFine').textContent = 'Camera access granted. Tap to open.'; }).catch(() => {});
  }

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        reg.addEventListener('updatefound', () => { const w = reg.installing; w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) this.toast.show('Update ready — reopen the app to use it', 4000); }); });
      } catch (e) { console.warn('SW registration failed', e); }
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
    this.loadVision();
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('resize', () => this.overlay.resize());
    screen.orientation?.addEventListener?.('change', () => setTimeout(() => this.overlay.resize(), 150));
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
      this.controls.setAI({ enabled: this.settings.get('aiEnabled'), busy: false });
      $('aboutCaps').textContent = `Vision runtime: MediaPipe Tasks (${this.backend.delegate} delegate). ${this.camera.lens.describe()}. Motion sensors: ${this.motion.available ? 'available' : 'unavailable'}.`;
    } catch (e) {
      console.error(e);
      this.controls.setAI({ enabled: false, busy: false });
      this.controls.setGuide({ code: 'ERR', text: 'AI unavailable — camera still works', tone: 'bad' });
      this.toast.show(`Could not load the vision models (${e.message}). Capture still works.`, 5000);
      this.settings.set('aiEnabled', false);
    }
  }

  // ---------------------------------------------------------------- UI bindings
  bindUI() {
    const c = this.controls, s = this.settings;
    c.on('mode', (m) => { s.set('mode', m); Haptics.tap(); });
    c.on('shutter', () => this.capture({ auto: false }));
    c.on('flip', async () => { Haptics.tap(); try { await this.camera.flip(); s.set('facing', this.camera.facing); this.onCameraStarted(); } catch (e) { this.toast.show('Could not switch camera'); } });
    c.on('flash', (v) => { s.set('flash', v); Haptics.tap(); });
    c.on('timer', (v) => { s.set('timer', v); Haptics.tap(); });
    c.on('zoom', (z) => this.setZoom(z, true));
    c.on('lens', (id) => this.camera.switchDevice(id).then(() => this.onCameraStarted()).catch(() => this.toast.show('Could not switch lens')));
    c.on('focus', async ({ x, y, px, py }) => { c.focusRingAt(px, py); const nx = this.camera.mirror ? 1 - x : x; await this.camera.focusAt(nx, y); });
    c.on('setting', ({ key, value }) => s.set(key, value));
    c.on('gallery', () => this.openLibrary());
    s.on('change', ({ key }) => this.applySettings(key));
    this.review.on('close', () => this.resumeAfterReview());
    this.review.on('retake', () => this.resumeAfterReview());
    this.libraryView.on('close', () => this.resumeAfterReview());
    this.libraryView.on('open', (rec) => { this.libraryView.hide(); this.review.show(rec, { recommendedFilter: rec.meta?.filter || 'natural' }); });
    this.autoCapture.on('capture', () => this.capture({ auto: true }));
    this.autoCapture.on('state', ({ state, progress }) => this.onAutoState(state, progress));
    this.autoCapture.on('cancel', () => { this.sounds.cancel(); this.controls.setCountdown(null); });
    this.camera.on('zoom', ({ zoom }) => this.controls.setZoom(zoom, this.state.zoomAdvice?.zoom ?? null));
    this.camera.on('stopped', () => { if (this.started && !document.hidden) this.toast.show('Camera stopped'); });
  }

  applySettings(key) {
    const s = this.settings, c = this.controls;
    const mode = s.get('mode');
    c.setMode(mode);
    c.setFlash(s.get('flash'), this.camera.supportsTorch);
    c.setTimer(s.get('timer'));
    c.setAI({ enabled: s.get('aiEnabled'), busy: !this.visionReady && s.get('aiEnabled') && this.started, thermal: this.vision.governor.thermal });
    c.setFilter(s.get('filter'), this.state.filterRec?.id);
    this.overlay.options.grid = s.get('grid'); this.overlay.options.horizon = s.get('horizon'); this.overlay.options.skeleton = s.get('skeleton');
    this.sounds.enabled = s.get('sound'); Haptics.enabled = s.get('haptics');
    this.autoCapture.configure({ holdMs: s.get('holdMs'), thresholds: { overall: s.get('autoThreshold') } });
    this.vision.governor.setMode(s.get('rate'));
    if (key === 'mirrorFront' || key === undefined) { this.camera.mirror = this.camera.facing === 'user' && s.get('mirrorFront'); this.overlay.options.mirror = this.camera.mirror; if (this.camera.isRunning) this.camera.setZoom(this.camera.zoom, { silent: true }); }
    if (key === 'exposure' && this.camera.isRunning) this.camera.setExposureCompensation(s.get('exposure')).then((ok) => { if (!ok) this.toast.show('Exposure control is not available on this camera'); });
    if (key === 'mode' || key === 'aiEnabled' || key === undefined) {
      this.reasoner.reset(); this.autoCapture.setEnabled(mode === 'pose' && s.get('aiEnabled'));
      this.controls.setCountdown(null); this.controls.setArmed(false);
      this.syncVisionRunning();
      if (!s.get('aiEnabled') || mode === 'photo') { this.controls.setGuide(null); this.controls.setScores(null, false); this.controls.setScene(null, false); this.overlay.draw({ mode: 'photo', motion: this.motion.read(), now: performance.now() }); }
    }
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
    if (s.get('exposure')) this.camera.setExposureCompensation(s.get('exposure'));
    this.tracker.reset(); this.reasoner.reset(); this.overlay.resize();
    this.syncVisionRunning();
  }

  onVisibility() {
    if (document.hidden) { this.vision.stop(); this.camera.stop(); }
    else if (this.started) this.camera.start({ facing: this.camera.facing, deviceId: this.camera.deviceId }).then(() => this.onCameraStarted()).catch(() => {});
  }

  async setZoom(z, fromUser) {
    const applied = await this.camera.setZoom(z);
    this.overlay.options.zoom = this.camera.digitalZoom;
    if (fromUser) this.zoomAdvisor.current = null;
    return applied;
  }

  // ---------------------------------------------------------------- per-frame pipeline
  onAnalysis(a) {
    if (this.capturing && this.settings.get('mode') !== 'pose') return;
    const now = a.t; const s = this.settings; const mode = s.get('mode');
    this.fps.frames++; if (now - this.fps.last > 1000) { this.fps.value = this.fps.frames; this.fps.frames = 0; this.fps.last = now; this.controls.setPerf(`${this.fps.value} fps · ${a.perf.inferenceMs} ms · ${a.perf.tier}${a.perf.lowPower ? ' · low battery' : ''}`); this.controls.setAI({ enabled: true, busy: false, thermal: a.perf.thermal }); }
    const motion = this.motion.read();

    // Layer 1 → structured data.
    const tracked = this.tracker.update({ people: a.people, faces: a.faces, t: now });
    const lighting = a.ran.lighting ? this.lighting.analyze(a.pixels, tracked.primary, motion.stability) : this.lighting.last;
    if (a.frame === 1 || a.ran.scene || a.ran.objects || a.frame % 6 === 0) this.state.scene = this.sceneClassifier.update({ sceneLabels: a.sceneLabels, objects: a.objects, tracked, lighting }).scene;
    const scene = this.state.scene;
    const composition = this.composition.evaluate({ tracked, scene, motion, pixels: a.pixels, objects: a.objects, aspect: a.width / a.height });
    const pose = this.poseScorer.score(tracked.primary);
    const group = tracked.count > 1 ? this.groupAnalyzer.analyze(tracked) : null;
    const stability = Math.round(clamp01((motion.available ? motion.stability : 1) * 0.5 + (tracked.primary ? pose.components.stability ?? 1 : 1) * 0.5) * 100);
    const scores = { pose: tracked.primary ? pose.score : null, framing: composition.framingScore, lighting: lighting?.score ?? null, stability };
    const W = OVERALL.weights;
    scores.overall = Math.round(((scores.pose ?? composition.framingScore) * W.pose + scores.framing * W.framing + (scores.lighting ?? 70) * W.lighting + stability * W.stability) / (W.pose + W.framing + W.lighting + W.stability));
    const presets = this.camera.lens.presets();
    const zoomAdvice = this.zoomAdvisor.recommend({ composition, scene, presets, currentZoom: this.camera.zoom, tracked, now });
    if (a.ran.lighting && (a.frame === 1 || a.frame % 12 === 0)) this.state.filterRec = this.filterRecommender.recommend({ lighting, scene });

    // Layer 2 → validated recommendation.
    const { stable: rec, raw } = this.reasoner.update({ mode, scene, tracked, composition, pose, lighting, motion, zoom: { current: this.camera.zoom, presets, advice: zoomAdvice }, group, scores }, now);
    const blocking = composition.issues.some((i) => i.severity >= 2) || (group?.issues.some((i) => i.severity >= 2) ?? false);
    const aligned = composition.hasSubject && !blocking && Math.hypot(composition.deviation.dx, composition.deviation.dy) <= COMPOSITION.tolerances.position * 1.2 && Math.abs(motion.rollDeg) <= COMPOSITION.levelToleranceDeg * 3;

    // Auto capture (Smart Pose).
    let holdProgress = 0;
    if (mode === 'pose') {
      const st = this.autoCapture.update({ scores, subject: tracked.primary, group, now });
      holdProgress = (st === 'HOLDING' || st === 'COUNTDOWN') ? this.autoCapture.progress : 0;
      this.controls.setArmed(st === 'HOLDING' || st === 'COUNTDOWN');
    }
    Object.assign(this.state, { tracked, composition, lighting, scores, rec, aligned, holdProgress, zoomAdvice, pose, group });

    // UI.
    const sub = this.subline({ scene, lighting, zoomAdvice, pose, tracked, mode, raw });
    this.controls.setGuide(this.phrase(rec || (raw.recommendation !== 'NONE' ? raw : null)), sub);
    this.controls.setScores(scores, mode === 'pose' && s.get('scores'));
    this.controls.setLevel(motion, s.get('horizon'));
    this.controls.setScene(scene, mode !== 'photo' && tracked.count === 0 && scene !== 'outdoor' && scene !== 'indoor');
    this.controls.setZoom(this.camera.zoom, zoomAdvice.action === 'ZOOM' ? zoomAdvice.zoom : null);
    if (this.state.filterRec && (a.frame === 1 || a.frame % 12 === 0)) this.controls.setFilter(s.get('filter'), this.state.filterRec.id);
    this.overlay.options.zoom = this.camera.digitalZoom;
    this.overlay.draw({ tracked, composition, motion, recommendation: rec, mode, aligned, holdProgress, now });
  }

  /**
   * Direction convention. The reasoner's codes always describe the camera
   * movement (pan right → subject slides left). Users who think in terms of
   * where the subject should go can flip the wording in settings.
   */
  phrase(rec) {
    if (!rec || this.settings.get('direction') !== 'subject') return rec;
    const flip = { MOVE_LEFT: ['Subject right', '→'], MOVE_RIGHT: ['Subject left', '←'], TILT_UP: ['Subject down', '↓'], TILT_DOWN: ['Subject up', '↑'], LESS_HEADROOM: ['Subject up', '↑'] };
    const f = flip[rec.code]; if (!f) return rec;
    return { ...rec, text: f[0], arrow: f[1] };
  }

  subline({ scene, lighting, zoomAdvice, pose, tracked, mode, raw }) {
    const bits = [];
    if (tracked.count > 1) bits.push(`${tracked.count} people`);
    if (lighting && raw.recommendation !== lighting.code && lighting.code !== 'LIGHT_GOOD') bits.push(lighting.advice);
    if (zoomAdvice.action === 'ZOOM' && raw.recommendation !== 'ZOOM') bits.push(`${zoomAdvice.zoom}× suggested`);
    if (mode === 'pose' && pose?.issues?.length && tracked.primary) bits.push(pose.issues[0]);
    return bits.slice(0, 2).join(' · ');
  }

  onAutoState(state, progress) {
    if (state === 'COUNTDOWN') { if (progress === 0 || progress == null) { this.sounds.ready(); Haptics.success(); } this.controls.setCountdown(progress ?? 0, 'Perfect'); }
    else if (state === 'HOLDING') { this.controls.setCountdown(null); }
    else { this.controls.setCountdown(null); this.controls.setArmed(false); }
  }

  // ---------------------------------------------------------------- capture
  async capture({ auto }) {
    if (this.capturing || !this.camera.isRunning) return;
    this.capturing = true; this.controls.setBusy(true);
    try {
      const s = this.settings;
      if (!auto && s.get('timer') > 0) { await this.runTimer(s.get('timer')); }
      const flash = s.get('flash');
      const useTorch = this.camera.supportsTorch && (flash === 'on' || (flash === 'auto' && this.state.lighting?.isDark));
      if (useTorch) { await this.camera.setTorch(true); await new Promise((r) => setTimeout(r, 350)); }
      this.sounds.shutter(); Haptics.shutter(); this.controls.flashScreen();
      const shot = await this.camera.capture({ mirrorOutput: this.camera.mirror });
      if (useTorch) this.camera.setTorch(false);
      const context = { subject: this.state.tracked?.primary ? { box: this.state.tracked.primary.box } : null, scene: this.state.scene };
      const processed = await this.processor.process(shot, context);
      const record = await this.library.add({
        blob: shot.blob, thumb: processed.thumb, width: shot.width, height: shot.height,
        meta: { auto, scene: this.state.scene, scores: this.state.scores, lighting: { advice: processed.lighting.advice, score: processed.lighting.score }, filter: processed.filter.id, zoom: this.camera.zoom, mode: s.get('mode'), composition: this.state.composition?.type },
      });
      this.autoCapture.captured(performance.now());
      this.controls.setCountdown(null);
      const count = await this.library.count();
      this.refreshThumb(count, record);
      if (auto) { this.toast.show(`Captured · ${processed.filter.name} look suggested`, 1800); }
      else { this.vision.stop(); this.review.show(record, { recommendedFilter: processed.filter.id, initialFilter: s.get('filter') }); }
    } catch (e) {
      console.error(e); this.toast.show(`Capture failed: ${e.message}`, 3000);
    } finally { this.capturing = false; this.controls.setBusy(false); }
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

  openLibrary() { this.vision.stop(); this.libraryView.show(); }
  resumeAfterReview() { this.tracker.reset(); this.reasoner.reset(); this.syncVisionRunning(); }
}

const app = new SmartCameraApp();
window.smartCamera = app; // handy for debugging in Safari's Web Inspector
app.boot();
