import { Emitter } from '../util/events.js';
import { AI_STYLES } from '../config/defaults.js';

/**
 * "Find the shot" — the ✦ button.
 *
 *  SCANNING  (3·2·1)  "AI is finding the shot…"  — pan around; candidates are
 *                      scored over the whole scan (interest × persistence).
 *  GUIDING             yellow box on the chosen subject, "Move your phone left…"
 *  FRAMING             centred → zoom to the best lens for the subject
 *  READY               green label, light comment, hold steady → capture
 *
 * Pure state machine: the app feeds it candidates, the tracked target box and
 * motion each frame, and applies what it returns (zoom, capture).
 * Events: 'acquire' {box, label, kind}, 'zoom' {zoom}, 'capture' {label}, 'end' {reason}
 */
export const FINDER = {
  scanMs: 3000,
  minScanFrames: 5,      // …and at least this many analysed frames (slow devices)
  enterTol: 0.07,        // off-centre distance that starts a "move" instruction
  exitTol: 0.04,         // …and the distance that counts as centred
  centeredHoldMs: 650,
  zoomSettleMs: 800,
  readyHoldMs: 1300,
  driftTol: 0.11,        // READY falls back to GUIDING beyond this offset
  minStability: 0.6,
  lostMs: 1600,
  lostFrames: 8,         // …and this many consecutive frames without the subject
};

export class ShotFinder extends Emitter {
  constructor(config = FINDER) { super(); this.config = { ...FINDER, ...config }; this.reset(); }

  reset() {
    this.state = 'IDLE'; this.target = null; this.agg = new Map(); this.message = null;
    this.startedAt = 0; this.centeredSince = 0; this.zoomAt = 0; this.readySince = 0; this.lastSeen = 0; this.moving = null; this.missFrames = 0;
  }

  get active() { return this.state !== 'IDLE'; }

  /** @param style one of AI_STYLES (Standard by default) */
  start(now, style = AI_STYLES[0]) { this.reset(); this.style = { ...AI_STYLES[0], ...style }; this.state = 'SCANNING'; this.startedAt = now; this.scanFrames = 0; }

  get styleOrDefault() { return this.style || AI_STYLES[0]; }

  /** Interest adjusted for the style (Snapchat favours faces, Scenic the view…). */
  weighted(c) { return c.score * (this.styleOrDefault.weights?.[c.kind] ?? 1); }

  /** Where the subject should end up in the frame for this style. */
  aimFor(target) {
    const st = this.styleOrDefault, b = target.box;
    let x = 0.5;
    if (st.aim === 'thirds' && Math.max(b.w, b.h) < 0.55) x = this.aimX ?? (b.x + b.w / 2 < 0.5 ? 1 / 3 : 2 / 3);
    let y = 0.5;
    if ((target.kind === 'person' || target.kind === 'group') && st.faceAim != null && target.head) y = st.faceAim;
    else if (target.kind === 'person' || target.kind === 'group') y = st.personAimY ?? 0.55;
    else if (target.kind === 'light') y = st.lightAimY ?? 0.5;
    return { x, y };
  }

  cancel(reason = 'cancelled') { const was = this.state; this.reset(); if (was !== 'IDLE') this.emit('end', { reason }); }

  /** Collect candidates while scanning. Key = label class; keep the best instance and how often it was seen. */
  collect(candidates) {
    for (const c of candidates) {
      const a = this.agg.get(c.key) || { frames: 0, sum: 0, best: null };
      const w = this.weighted(c);
      a.frames++; a.sum += w;
      if (!a.best || w >= this.weighted(a.best)) a.best = c;
      this.agg.set(c.key, a);
    }
  }

  /** Winner = mean interest × persistence. */
  choose(current) {
    let win = null, winScore = -1;
    for (const [key, a] of this.agg) {
      const s = (a.sum / a.frames) * (0.6 + 0.4 * Math.min(1, a.frames / 8));
      if (s > winScore) { winScore = s; win = key; }
    }
    const by = (a, b) => this.weighted(b) - this.weighted(a);
    if (!win) return current.sort(by)[0] || null;
    // Prefer where it is right now; otherwise the best thing visible now.
    const now = current.filter((c) => c.key === win).sort(by)[0];
    return now || current.sort(by)[0] || null;
  }

  /**
   * Zoom that frames the subject best for the style. Presets (optical lenses)
   * by default; continuous zoom for styles that want exact framing (Cinematic
   * zooms in ~1.8× tighter). Scenic goes to the widest lens.
   */
  static chooseZoom(target, current, presets = [], style = {}) {
    const factors = presets.map((p) => p.factor).sort((a, b) => a - b);
    if (!factors.length || !target) return null;
    const minF = factors[0], maxF = Math.min(style.maxZoom ?? Infinity, factors[factors.length - 1]);
    let desired;
    if (style.zoom === 'wide') desired = minF;
    else if (target.kind === 'light') desired = (current < 2 ? 2 : current) * (style.zoomScale ?? 1);
    else {
      const size = Math.max(target.box.h, target.box.w * 0.75);
      const person = target.kind === 'person' || target.kind === 'group';
      const frac = person ? (style.personFrac ?? 0.6) : target.box.w * target.box.h < 0.012 ? 0.16 : 0.32;
      desired = current * (frac / Math.max(0.005, size)) * (style.zoomScale ?? 1);
    }
    let pick;
    if (style.continuous) pick = Math.round(Math.min(maxF, Math.max(minF, desired)) * 10) / 10;
    else { pick = minF; for (const f of factors) if (f <= desired * 1.05 && f <= maxF) pick = f; }
    return Math.abs(pick - current) / current < 0.05 ? null : pick;
  }

  static lightMessage(lighting, style = {}) {
    if (!lighting) return style.readyText || 'hold the focus.';
    if (lighting.code === 'BACKLIT') return 'strong backlight, hold the focus.';
    if (lighting.isNight || lighting.code === 'TOO_DARK') return 'low light — hold very still.';
    if (lighting.code === 'TOO_BRIGHT') return 'bright light, hold the focus.';
    return style.readyText || 'beautiful light, hold the focus.';
  }

  /**
   * @param input { candidates, track: {box, lost}|null, motion, zoom: {current, presets}, lighting }
   * @returns view model for the UI
   */
  update(input, now) {
    const C = this.config;
    const { candidates = [], track = null, motion = { stability: 1 }, zoom = { current: 1, presets: [] }, lighting = null } = input;
    const vm = { state: this.state, countdown: 0, message: null, tone: 'yellow', target: null, label: null, offset: null };

    if (this.state === 'SCANNING') {
      this.collect(candidates); this.scanFrames++;
      const elapsed = now - this.startedAt;
      const total = this.styleOrDefault.scanMs ?? C.scanMs;
      vm.countdown = Math.max(1, Math.ceil((total - elapsed) / (total / 3)));
      vm.message = 'Finding your shot...';
      const st = this.styleOrDefault;
      if (elapsed >= (st.scanMs ?? C.scanMs) && this.scanFrames >= (st.minScanFrames ?? C.minScanFrames)) {
        const pick = this.choose(candidates);
        if (!pick) { this.cancel('nothing'); return { ...vm, state: 'IDLE', message: 'Nothing stood out — tap ✦ to try again', tone: 'gray' }; }
        this.target = { ...pick }; this.lastSeen = now;
        this.aimX = null; this.aimX = this.aimFor(this.target).x;   // fix the third once, so it never flips
        this.state = 'GUIDING';
        this.emit('acquire', { box: pick.box, label: pick.label, kind: pick.kind });
      }
      return vm;
    }
    if (this.state === 'IDLE') return vm;

    // Follow the subject.
    if (track && !track.lost) { this.target.box = track.box; if (track.head) this.target.head = track.head; this.lastSeen = now; this.missFrames = 0; }
    else this.missFrames = (this.missFrames || 0) + 1;
    if (now - this.lastSeen > C.lostMs && this.missFrames >= C.lostFrames) { const label = this.target?.label || 'subject'; this.cancel('lost'); return { ...vm, state: 'IDLE', message: `Lost the ${label} — tap ✦ to rescan`, tone: 'gray' }; }

    const b = this.target.box;
    // Aim point depends on the style (thirds for Cinematic/Street/Film; people slightly
    // below centre for headroom; faces higher for Snapchat).
    const st = this.styleOrDefault;
    const aim = this.aimFor(this.target);
    // Face-first styles (Snapchat) steer by the face, not the middle of the body.
    const faceFirst = st.faceAim != null && this.target.head;
    const pt = faceFirst ? this.target.head : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = pt.x - aim.x;
    // A face anywhere inside the style's band is fine (Snapchat: upper part of the frame;
    // Cinematic: the middle of the widescreen strip); only the distance outside counts.
    const [up, down] = st.faceBand || [0.1, 0.08];
    const dy = faceFirst ? (pt.y < aim.y - up ? pt.y - (aim.y - up) : pt.y > aim.y + down ? pt.y - (aim.y + down) : 0) : pt.y - aim.y;
    const off = Math.hypot(dx, dy);
    // Big subjects need less precise centring than a distant boat.
    const big = Math.max(b.w, b.h);
    const k = st.tolScale ?? 1;
    // A coming zoom magnifies any leftover offset, so centre more precisely first.
    const zNext = this.state === 'GUIDING' ? ShotFinder.chooseZoom(this.target, zoom.current, zoom.presets, st) : null;
    const ratio = zNext ? Math.max(1, zNext / zoom.current) : 1;
    const driftTol = Math.max(C.driftTol * k, 0.2 * big);
    const enterTol = Math.max(0.02, Math.min(Math.max(C.enterTol * k, 0.15 * big), (driftTol * 0.8) / ratio));
    const exitTol = Math.max(0.015, Math.min(Math.max(C.exitTol * k, 0.1 * big), (driftTol * 0.55) / ratio));
    vm.target = b; vm.label = this.target.label; vm.offset = { dx, dy }; vm.aim = aim;

    if (this.state === 'FRAMING') {
      vm.message = 'Framing your shot...'; vm.state = 'FRAMING';
      if (now - this.zoomAt >= C.zoomSettleMs) { this.state = 'READY'; this.readySince = now; }
      return vm;
    }

    if (this.state === 'READY') {
      if (off > driftTol) { this.state = 'GUIDING'; this.centeredSince = 0; }
      else {
        vm.state = 'READY'; vm.tone = 'green'; vm.message = ShotFinder.lightMessage(lighting, st);
        const hold = st.readyHoldMs ?? C.readyHoldMs;
        if ((motion.stability ?? 1) < (st.minStability ?? C.minStability)) this.readySince = now;
        // Scenic: the horizon must be level before the shutter fires.
        if (st.requireLevel && motion.available && !motion.flat && Math.abs(motion.rollDeg ?? 0) > 2.5) {
          this.readySince = now; vm.tone = 'yellow'; vm.message = 'Level your phone';
        }
        vm.progress = Math.min(1, (now - this.readySince) / hold);
        if (now - this.readySince >= hold) {
          const label = this.target.label, box = { ...this.target.box }, head = this.target.head ? { ...this.target.head } : null, style = st.id;
          this.reset();
          this.emit('capture', { label, box, head, style });
          return { ...vm, state: 'CAPTURE' };
        }
        return vm;
      }
    }

    // GUIDING: one instruction at a time, with hysteresis.
    vm.state = 'GUIDING';
    const tol = this.moving ? exitTol : enterTol;
    if (off > tol) {
      this.centeredSince = 0;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      this.moving = horizontal ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
      vm.message = `Move your phone ${this.moving}`;
      return vm;
    }
    this.moving = null;
    if (!this.centeredSince) this.centeredSince = now;
    vm.message = 'Centered — framing up...';
    if (now - this.centeredSince >= C.centeredHoldMs) {
      const z = ShotFinder.chooseZoom(this.target, zoom.current, zoom.presets, st);
      if (z) { this.state = 'FRAMING'; this.zoomAt = now; this.emit('zoom', { zoom: z, from: zoom.current }); vm.message = 'Framing your shot...'; vm.state = 'FRAMING'; }
      else { this.state = 'READY'; this.readySince = now; }
    }
    return vm;
  }
}
