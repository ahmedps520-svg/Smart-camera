import { Emitter } from '../util/events.js';

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

  start(now) { this.reset(); this.state = 'SCANNING'; this.startedAt = now; this.scanFrames = 0; }

  cancel(reason = 'cancelled') { const was = this.state; this.reset(); if (was !== 'IDLE') this.emit('end', { reason }); }

  /** Collect candidates while scanning. Key = label class; keep the best instance and how often it was seen. */
  collect(candidates) {
    for (const c of candidates) {
      const a = this.agg.get(c.key) || { frames: 0, sum: 0, best: null };
      a.frames++; a.sum += c.score;
      if (!a.best || c.score >= a.best.score) a.best = c;
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
    if (!win) return current.sort((a, b) => b.score - a.score)[0] || null;
    // Prefer where it is right now; otherwise the best thing visible now.
    const now = current.filter((c) => c.key === win).sort((a, b) => b.score - a.score)[0];
    return now || current.sort((a, b) => b.score - a.score)[0] || null;
  }

  /** Which preset zoom frames the subject best (never zooms past what keeps it whole). */
  static chooseZoom(target, current, presets = []) {
    const factors = presets.map((p) => p.factor).sort((a, b) => a - b);
    if (!factors.length || !target) return null;
    let desired;
    if (target.kind === 'light') desired = current < 2 ? 2 : current;
    else {
      const size = Math.max(target.box.h, target.box.w * 0.75);
      const frac = target.kind === 'person' || target.kind === 'group' ? 0.6 : target.box.w * target.box.h < 0.012 ? 0.16 : 0.32;
      desired = current * (frac / Math.max(0.005, size));
    }
    let pick = factors[0];
    for (const f of factors) if (f <= desired * 1.05) pick = f;
    return Math.abs(pick - current) / current < 0.05 ? null : pick;
  }

  static lightMessage(lighting) {
    if (!lighting) return 'hold the focus.';
    if (lighting.code === 'BACKLIT') return 'strong backlight, hold the focus.';
    if (lighting.isNight || lighting.code === 'TOO_DARK') return 'low light — hold very still.';
    if (lighting.code === 'TOO_BRIGHT') return 'bright light, hold the focus.';
    return 'beautiful light, hold the focus.';
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
      vm.countdown = Math.max(1, 3 - Math.floor(elapsed / 1000));
      vm.message = 'Finding your shot...';
      if (elapsed >= C.scanMs && this.scanFrames >= C.minScanFrames) {
        const pick = this.choose(candidates);
        if (!pick) { this.cancel('nothing'); return { ...vm, state: 'IDLE', message: 'Nothing stood out — tap ✦ to try again', tone: 'gray' }; }
        this.target = { ...pick }; this.lastSeen = now;
        this.state = 'GUIDING';
        this.emit('acquire', { box: pick.box, label: pick.label, kind: pick.kind });
      }
      return vm;
    }
    if (this.state === 'IDLE') return vm;

    // Follow the subject.
    if (track && !track.lost) { this.target.box = track.box; this.lastSeen = now; this.missFrames = 0; }
    else this.missFrames = (this.missFrames || 0) + 1;
    if (now - this.lastSeen > C.lostMs && this.missFrames >= C.lostFrames) { const label = this.target?.label || 'subject'; this.cancel('lost'); return { ...vm, state: 'IDLE', message: `Lost the ${label} — tap ✦ to rescan`, tone: 'gray' }; }

    const b = this.target.box;
    // People are aimed slightly below centre, which leaves natural headroom.
    const aimY = this.target.kind === 'person' || this.target.kind === 'group' ? 0.55 : 0.5;
    const dx = b.x + b.w / 2 - 0.5, dy = b.y + b.h / 2 - aimY;
    const off = Math.hypot(dx, dy);
    // Big subjects need less precise centring than a distant boat.
    const big = Math.max(b.w, b.h);
    const enterTol = Math.max(C.enterTol, 0.15 * big), exitTol = Math.max(C.exitTol, 0.1 * big), driftTol = Math.max(C.driftTol, 0.2 * big);
    vm.target = b; vm.label = this.target.label; vm.offset = { dx, dy };

    if (this.state === 'FRAMING') {
      vm.message = 'Framing your shot...'; vm.state = 'FRAMING';
      if (now - this.zoomAt >= C.zoomSettleMs) { this.state = 'READY'; this.readySince = now; }
      return vm;
    }

    if (this.state === 'READY') {
      if (off > driftTol) { this.state = 'GUIDING'; this.centeredSince = 0; }
      else {
        vm.state = 'READY'; vm.tone = 'green'; vm.message = ShotFinder.lightMessage(lighting);
        if ((motion.stability ?? 1) < C.minStability) this.readySince = now;
        vm.progress = Math.min(1, (now - this.readySince) / C.readyHoldMs);
        if (now - this.readySince >= C.readyHoldMs) {
          const label = this.target.label;
          this.reset();
          this.emit('capture', { label });
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
      const z = ShotFinder.chooseZoom(this.target, zoom.current, zoom.presets);
      if (z) { this.state = 'FRAMING'; this.zoomAt = now; this.emit('zoom', { zoom: z, from: zoom.current }); vm.message = 'Framing your shot...'; vm.state = 'FRAMING'; }
      else { this.state = 'READY'; this.readySince = now; }
    }
    return vm;
  }
}
