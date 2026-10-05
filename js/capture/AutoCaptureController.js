import { AUTO_CAPTURE } from '../config/defaults.js';
import { Emitter } from '../util/events.js';
import { dist } from '../util/math.js';

const vis = (p) => !!p && (p.visibility ?? 1) >= 0.45;
const SIG = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26];

/**
 * Smart Pose auto-capture state machine.
 *
 *   MONITORING → HOLDING → COUNTDOWN → CAPTURING → COOLDOWN → MONITORING
 *
 * - Conditions: overall score above the threshold, every other score above its floor,
 *   and (for groups) everyone still.
 * - Short dips below the threshold (graceMs) are ignored so landmark jitter does not
 *   reset the hold.
 * - Movement is measured in torso lengths, from the pose at the start of the hold:
 *   real movement cancels, jitter does not.
 * - After a capture the same pose is not shot again until it changes or
 *   repeatAfterMs has passed.
 *
 * Events: 'state' {state, progress}, 'capture', 'cancel' {reason}
 */
export class AutoCaptureController extends Emitter {
  constructor(config = AUTO_CAPTURE) {
    super();
    this.config = { ...AUTO_CAPTURE, ...config, thresholds: { ...AUTO_CAPTURE.thresholds, ...(config.thresholds || {}) } };
    this.state = 'IDLE';
    this.holdStart = 0; this.countdownStart = 0; this.cooldownUntil = 0; this.lastOkAt = 0;
    this.reference = null; this.captured = null;
    this.enabled = false;
    this.progress = 0;
    this.blockers = [];
  }

  /** Partial update; thresholds are merged so a single override never wipes the others. */
  configure(patch) {
    const { thresholds, ...rest } = patch;
    Object.assign(this.config, rest);
    if (thresholds) this.config.thresholds = { ...this.config.thresholds, ...thresholds };
  }

  setEnabled(on) { this.enabled = on; this.reference = null; this.transition(on ? 'MONITORING' : 'IDLE'); }

  transition(state, extra = {}) {
    if (this.state === state) return;
    this.state = state; this.progress = 0;
    this.emit('state', { state, ...extra });
  }

  /** Body scale (≈ torso length) used to normalise movement. */
  static scale(subject) {
    const l = subject?.landmarks;
    if (l) {
      const sh = { x: (l[11].x + l[12].x) / 2, y: (l[11].y + l[12].y) / 2 };
      if (vis(l[23]) || vis(l[24])) {
        const hip = { x: (l[23].x + l[24].x) / 2, y: (l[23].y + l[24].y) / 2 };
        const t = dist(sh, hip); if (t > 0.02) return t;
      }
      const sw = dist(l[11], l[12]); if (sw > 0.02) return sw * 1.3;
      if (subject.faceH) return subject.faceH * 4;
    }
    if (subject?.faceBox) return subject.faceBox.h * 2;
    return Math.max(0.05, (subject?.box?.h || 0.3) * 0.35);
  }

  /** Pose snapshot: anchor point, scale, and key joints relative to the anchor in scale units. */
  static snapshot(subject) {
    if (!subject) return null;
    const s = AutoCaptureController.scale(subject);
    const anchor = subject.head || subject.center;
    const points = subject.landmarks ? SIG.map((i) => (vis(subject.landmarks[i]) ? { x: (subject.landmarks[i].x - anchor.x) / s, y: (subject.landmarks[i].y - anchor.y) / s } : null)) : [];
    return { anchor: { ...anchor }, scale: s, points };
  }

  /** Movement between snapshots in torso lengths (pose change + translation). */
  static movement(a, b) {
    if (!a || !b) return Infinity;
    const s = (a.scale + b.scale) / 2;
    const shift = dist(a.anchor, b.anchor) / s;
    let sum = 0, n = 0;
    for (let i = 0; i < Math.min(a.points.length, b.points.length); i++) {
      if (a.points[i] && b.points[i]) { sum += dist(a.points[i], b.points[i]); n++; }
    }
    const pose = n >= 3 ? sum / n : 0;
    return { shift, pose, total: Math.max(shift, pose) };
  }

  check(scores, group, eyesOpen = null) {
    const T = this.config.thresholds; const b = [];
    if ((scores.overall ?? 0) < T.overall) b.push('overall');
    if ((scores.pose ?? 0) < T.pose) b.push('pose');
    if ((scores.framing ?? 0) < T.framing) b.push('framing');
    if ((scores.stability ?? 0) < T.stability) b.push('stability');
    if (scores.lighting != null && scores.lighting < T.lighting) b.push('lighting');
    if (group && group.stable === false) b.push('group');
    if (eyesOpen != null && eyesOpen < this.config.eyesOpenMin) b.push('eyes');
    this.blockers = b;
    return b.length === 0;
  }

  /** @param {{scores, subject, group, now:number}} s */
  update({ scores, subject, group, now, eyesOpen = null }) {
    if (!this.enabled || this.state === 'IDLE' || this.state === 'CAPTURING') return this.state;
    if (this.state === 'COOLDOWN') {
      if (now < this.cooldownUntil) return this.state;
      this.transition('MONITORING');
    }
    if (!subject) { this.blockers = ['subject']; if (this.state !== 'MONITORING') this.cancel('Subject lost'); return this.state; }

    const snap = AutoCaptureController.snapshot(subject);
    let ok = this.check(scores, group, eyesOpen);
    if (ok && this.captured && now - this.captured.at < this.config.repeatAfterMs) {
      const m = AutoCaptureController.movement(snap, this.captured.snap);
      if (m.pose < this.config.requirePoseChange && m.shift < this.config.requirePoseChange * 2) { ok = false; this.blockers = ['same pose']; }
    }
    if (ok) this.lastOkAt = now;
    const withinGrace = now - this.lastOkAt <= this.config.graceMs;

    if (this.state === 'MONITORING') {
      if (ok) { this.holdStart = now; this.reference = snap; this.transition('HOLDING'); }
      return this.state;
    }

    const moved = AutoCaptureController.movement(snap, this.reference).total > this.config.cancelMovement;
    if (this.state === 'HOLDING') {
      if (moved) { this.cancel('Moved'); return this.state; }
      if (!withinGrace) { this.cancel('Conditions changed'); return this.state; }
      const hold = this.config.holdMs + (group ? this.config.groupSettleMs : 0);
      this.progress = Math.min(1, (now - this.holdStart) / hold);
      this.emit('state', { state: 'HOLDING', progress: this.progress });
      if (ok && now - this.holdStart >= hold) { this.countdownStart = now; this.transition('COUNTDOWN'); }
      return this.state;
    }
    if (this.state === 'COUNTDOWN') {
      if (moved) { this.cancel('Moved during countdown'); return this.state; }
      if (!withinGrace && !this.blockers.every((b) => b === 'eyes')) { this.cancel('Conditions changed'); return this.state; }
      this.progress = Math.min(1, (now - this.countdownStart) / this.config.countdownMs);
      this.emit('state', { state: 'COUNTDOWN', progress: this.progress });
      if (now - this.countdownStart >= this.config.countdownMs) {
        // Blink guard: hold the shutter (briefly) until everyone's eyes are open.
        if (eyesOpen != null && eyesOpen < this.config.eyesOpenMin && now - this.countdownStart < this.config.countdownMs + this.config.blinkWaitMs) return this.state;
        this.captured = { snap, at: now };
        this.transition('CAPTURING');
        this.emit('capture', { scores });
      }
    }
    return this.state;
  }

  /** Call when the capture (auto or manual) has finished. */
  markCaptured(now) { this.cooldownUntil = now + this.config.cooldownMs; this.transition('COOLDOWN'); }

  cancel(reason) { this.reference = null; this.transition('MONITORING'); this.emit('cancel', { reason }); }
}
