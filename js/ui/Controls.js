import { Emitter } from '../util/events.js';
import { FILTERS, ZOOM } from '../config/defaults.js';

const $ = (id) => document.getElementById(id);

/**
 * Binds the camera UI (top bar, modes, zoom chips/slider, pinch, panel) to the
 * app. Emits: 'mode', 'zoom', 'flash', 'timer', 'flip', 'shutter', 'focus',
 * 'setting' {key, value}, 'lens', 'gallery', 'panel'.
 */
export class Controls extends Emitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.el = {
      app: $('app'), viewport: $('viewport'), video: $('video'), guidePill: $('guidePill'), guideText: $('guideText'), guideArrow: $('guideArrow'), guideSub: $('guideSub'),
      countdown: $('countdown'), countdownText: $('countdownText'), countdownArc: $('countdownArc'),
      scores: $('scores'), levelReadout: $('levelReadout'), levelText: $('levelText'), sceneChip: $('sceneChip'),
      zoomChips: $('zoomChips'), zoomHint: $('zoomHint'), zoomSlider: $('zoomSlider'), modes: $('modes'),
      btnShutter: $('btnShutter'), btnFlip: $('btnFlip'), btnFlash: $('btnFlash'), flashBadge: $('flashBadge'), btnTimer: $('btnTimer'), timerBadge: $('timerBadge'),
      btnPanel: $('btnPanel'), btnSelfie: $('btnSelfie'), panel: $('panel'), btnAI: $('btnAI'), aiLabel: $('aiLabel'), btnGallery: $('btnGallery'), thumbImg: $('thumbImg'), thumbCount: $('thumbCount'),
      flash: $('flash'), focusRing: $('focusRing'), perf: $('perfReadout'), filters: $('filters'), lens: $('ctlLens'), toast: $('toast'),
    };
    this.lastGuideCode = null;
    this.bind();
  }

  bind() {
    const e = this.el, s = this.settings;
    e.modes.addEventListener('click', (ev) => { const b = ev.target.closest('.mode'); if (b) this.emit('mode', b.dataset.mode); });
    e.btnShutter.addEventListener('click', () => this.emit('shutter'));
    e.btnFlip.addEventListener('click', () => this.emit('flip'));
    e.btnSelfie.addEventListener('click', () => this.emit('selfie'));
    e.btnFlash.addEventListener('click', () => { const order = ['off', 'auto', 'on']; const next = order[(order.indexOf(s.get('flash')) + 1) % order.length]; this.emit('flash', next); });
    e.btnTimer.addEventListener('click', () => { const order = [0, 3, 10]; const next = order[(order.indexOf(s.get('timer')) + 1) % order.length]; this.emit('timer', next); });
    e.btnPanel.addEventListener('click', () => this.togglePanel());
    e.btnAI.addEventListener('click', () => this.emit('setting', { key: 'aiEnabled', value: !s.get('aiEnabled') }));
    e.btnGallery.addEventListener('click', () => this.emit('gallery'));
    $('btnAbout').addEventListener('click', () => $('about').showModal());
    e.zoomSlider.addEventListener('input', () => this.emit('zoom', parseFloat(e.zoomSlider.value)));
    e.zoomChips.addEventListener('click', (ev) => { const c = ev.target.closest('.zoom-chip'); if (c) this.emit('zoom', parseFloat(c.dataset.factor)); });
    e.lens.addEventListener('change', () => this.emit('lens', e.lens.value));

    // Panel toggles → settings.
    const map = { ctlAI: 'aiEnabled', ctlGrid: 'grid', ctlHorizon: 'horizon', ctlSkeleton: 'skeleton', ctlScores: 'scores', ctlSound: 'sound', ctlMirror: 'mirrorFront', ctlHaptics: 'haptics' };
    for (const [id, key] of Object.entries(map)) { const el = $(id); el.checked = !!s.get(key); el.addEventListener('change', () => this.emit('setting', { key, value: el.checked })); }
    const ex = $('ctlExposure'); ex.value = s.get('exposure'); $('ctlExposureV').textContent = Number(s.get('exposure')).toFixed(1);
    ex.addEventListener('input', () => { $('ctlExposureV').textContent = Number(ex.value).toFixed(1); this.emit('setting', { key: 'exposure', value: parseFloat(ex.value) }); });
    const th = $('ctlThreshold'); th.value = s.get('autoThreshold'); $('ctlThresholdV').textContent = th.value;
    th.addEventListener('input', () => { $('ctlThresholdV').textContent = th.value; this.emit('setting', { key: 'autoThreshold', value: parseInt(th.value, 10) }); });
    const hold = $('ctlHold'); hold.value = (s.get('holdMs') / 1000).toFixed(2); $('ctlHoldV').textContent = `${(s.get('holdMs') / 1000).toFixed(1)}s`;
    hold.addEventListener('input', () => { $('ctlHoldV').textContent = `${Number(hold.value).toFixed(1)}s`; this.emit('setting', { key: 'holdMs', value: Math.round(parseFloat(hold.value) * 1000) }); });
    const rate = $('ctlRate'); rate.value = s.get('rate'); rate.addEventListener('change', () => this.emit('setting', { key: 'rate', value: rate.value }));
    const str = $('ctlStrength'); str.value = s.get('filterStrength'); $('ctlStrengthV').textContent = `${Math.round(s.get('filterStrength') * 100)}%`;
    str.addEventListener('input', () => { $('ctlStrengthV').textContent = `${Math.round(str.value * 100)}%`; this.emit('setting', { key: 'filterStrength', value: parseFloat(str.value) }); });
    const asp = $('ctlAspect'); asp.value = s.get('aspect'); asp.addEventListener('change', () => this.emit('setting', { key: 'aspect', value: asp.value }));
    const dir = $('ctlDirection'); dir.value = s.get('direction'); dir.addEventListener('change', () => this.emit('setting', { key: 'direction', value: dir.value }));

    // Filters.
    for (const f of FILTERS) { const b = document.createElement('button'); b.className = 'filter-chip'; b.dataset.id = f.id; b.textContent = f.name; b.addEventListener('click', () => this.emit('setting', { key: 'filter', value: f.id })); e.filters.appendChild(b); }

    // Pinch to zoom + tap to focus on the viewport.
    this.pointers = new Map(); this.pinchStart = null; this.tapStart = null;
    e.viewport.addEventListener('pointerdown', (ev) => { this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.currentZoom || 1 }; this.tapStart = null; } else if (this.pointers.size === 1) this.tapStart = { x: ev.clientX, y: ev.clientY, t: performance.now() }; });
    e.viewport.addEventListener('pointermove', (ev) => { if (!this.pointers.has(ev.pointerId)) return; this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); if (this.pointers.size === 2 && this.pinchStart) { const [a, b] = [...this.pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); this.emit('zoom', this.pinchStart.zoom * (d / this.pinchStart.d)); } });
    const up = (ev) => { const p = this.tapStart; this.pointers.delete(ev.pointerId); if (this.pointers.size < 2) this.pinchStart = null; if (p && this.pointers.size === 0 && performance.now() - p.t < 350 && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 10) { const r = e.viewport.getBoundingClientRect(); this.emit('focus', { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height, px: ev.clientX - r.left, py: ev.clientY - r.top }); } this.tapStart = null; };
    e.viewport.addEventListener('pointerup', up); e.viewport.addEventListener('pointercancel', up);
    // Close the panel when tapping the preview.
    e.viewport.addEventListener('pointerdown', () => { if (e.panel.classList.contains('open')) this.togglePanel(false); });
    document.addEventListener('keydown', (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { if (document.activeElement === document.body) { ev.preventDefault(); this.emit('shutter'); } } });
  }

  togglePanel(force) {
    const open = force ?? !this.el.panel.classList.contains('open');
    this.el.panel.classList.toggle('open', open); this.el.panel.setAttribute('aria-hidden', String(!open)); this.el.btnPanel.setAttribute('aria-expanded', String(open));
    this.emit('panel', open);
  }

  // ---------- Rendering helpers ----------
  setMode(mode) { for (const b of this.el.modes.querySelectorAll('.mode')) b.setAttribute('aria-selected', String(b.dataset.mode === mode)); this.el.app.dataset.mode = mode; }
  setFlash(state, supported) { this.el.btnFlash.dataset.state = state; this.el.flashBadge.textContent = state === 'auto' ? 'A' : state === 'on' ? 'ON' : ''; this.el.btnFlash.style.opacity = supported ? '1' : '0.45'; this.el.btnFlash.title = supported ? 'Flash' : 'Flash not available on this camera'; }
  setTimer(sec) { this.el.timerBadge.textContent = sec ? `${sec}s` : ''; this.el.btnTimer.dataset.state = sec ? 'on' : 'off'; }
  setAI({ enabled, busy, thermal }) { this.el.btnAI.setAttribute('aria-pressed', String(enabled)); this.el.btnAI.dataset.busy = String(!!busy); this.el.btnAI.dataset.thermal = thermal || 'nominal'; this.el.aiLabel.textContent = !enabled ? 'AI OFF' : busy ? 'LOADING' : 'ON-DEVICE'; }
  setZoomPresets(presets, current, recommended) {
    const c = this.el.zoomChips; c.innerHTML = '';
    for (const p of presets) { const b = document.createElement('button'); b.className = 'zoom-chip'; b.dataset.factor = p.factor; b.textContent = `${p.factor}×`; b.title = p.optical ? 'Optical' : 'Digital'; if (!p.optical) b.style.fontStyle = 'italic'; c.appendChild(b); }
    this.el.zoomSlider.min = Math.min(...presets.map((p) => p.factor), 1); this.el.zoomSlider.max = ZOOM.maxDigital;
    this.setZoom(current, recommended);
  }
  setZoom(z, recommended = null) {
    this.currentZoom = z;
    const chips = [...this.el.zoomChips.querySelectorAll('.zoom-chip')];
    let nearest = null, nd = 1e9;
    for (const ch of chips) { const f = parseFloat(ch.dataset.factor); const d = Math.abs(f - z); ch.classList.toggle('recommended', recommended != null && Math.abs(f - recommended) < 1e-6); if (d < nd) { nd = d; nearest = ch; } }
    for (const ch of chips) ch.classList.toggle('active', ch === nearest && nd < 0.06);
    if (nearest && nd >= 0.06) nearest.classList.remove('active');
    if (Math.abs(parseFloat(this.el.zoomSlider.value) - z) > 0.01) this.el.zoomSlider.value = z;
    this.el.zoomHint.hidden = recommended == null || Math.abs(recommended - z) < 0.06;
    if (!this.el.zoomHint.hidden) this.el.zoomHint.textContent = `${recommended}× recommended`;
  }
  setLenses(devices, currentId) { const sel = this.el.lens; sel.innerHTML = ''; for (const d of devices) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Camera ${sel.length + 1}`; if (d.deviceId === currentId) o.selected = true; sel.appendChild(o); } sel.parentElement.hidden = devices.length < 2; }
  setFilter(id, recommendedId) { for (const b of this.el.filters.querySelectorAll('.filter-chip')) { b.classList.toggle('active', b.dataset.id === id); b.classList.toggle('recommended', b.dataset.id === recommendedId); } }
  setSelfie(on) { this.el.btnSelfie.setAttribute('aria-pressed', String(on)); }
  setGuide(rec, sub = '') {
    const p = this.el.guidePill;
    if (!rec) { p.dataset.tone = 'hidden'; this.lastGuideCode = null; this.el.guideSub.textContent = sub; return; }
    if (rec.code !== this.lastGuideCode) { p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump'); this.lastGuideCode = rec.code; }
    p.dataset.tone = rec.tone || 'neutral'; this.el.guideText.textContent = rec.text || rec.recommendation; this.el.guideArrow.textContent = rec.arrow || '';
    this.el.guideSub.textContent = sub;
  }
  /** @param blockers score keys currently stopping auto capture (shown in red) */
  setScores(sc, visible, blockers = []) {
    this.el.scores.hidden = !visible; if (!visible || !sc) return;
    const set = (bar, val, key) => { const b = document.getElementById(bar), v = document.getElementById(`${bar}V`); b.style.width = `${val}%`; b.className = blockers.includes(key) ? 'bad' : val >= 75 ? 'good' : ''; v.textContent = sc[key] == null ? '–' : Math.round(val); };
    set('scPose', sc.pose ?? 0, 'pose'); set('scFrame', sc.framing ?? 0, 'framing'); set('scLight', sc.lighting ?? 0, 'lighting'); set('scStab', sc.stability ?? 0, 'stability'); set('scAll', sc.overall ?? 0, 'overall');
  }
  setLevel(motion, visible) { const el = this.el.levelReadout; el.hidden = !visible || !motion?.available || motion.flat; if (el.hidden) return; el.classList.toggle('level', motion.level); this.el.levelText.textContent = motion.level ? 'LEVEL' : `${Math.abs(motion.rollDeg).toFixed(0)}°`; }
  setScene(scene, visible) { this.el.sceneChip.hidden = !visible || !scene; if (scene) this.el.sceneChip.textContent = scene; }
  setCountdown(progress, text) { const c = this.el.countdown; if (progress == null) { c.classList.remove('show'); return; } c.classList.add('show'); this.el.countdownText.textContent = text; this.el.countdownArc.style.strokeDashoffset = String(283 * (1 - progress)); }
  setArmed(on) { this.el.btnShutter.dataset.armed = String(on); }
  setBusy(on) { this.el.btnShutter.dataset.busy = String(on); }
  flashScreen() { const f = this.el.flash; f.classList.remove('fire'); void f.offsetWidth; f.classList.add('fire'); }
  focusRingAt(px, py) { const r = this.el.focusRing; r.style.left = `${px}px`; r.style.top = `${py}px`; r.classList.remove('show'); void r.offsetWidth; r.classList.add('show'); }
  setThumb(url, count) { const i = this.el.thumbImg; if (url) { i.src = url; i.hidden = false; } else i.hidden = true; this.el.thumbCount.hidden = !count; this.el.thumbCount.textContent = count || ''; }
  setPerf(text) { this.el.perf.textContent = text; }
}
