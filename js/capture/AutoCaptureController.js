import { AUTO_CAPTURE } from '../config/defaults.js';
import { Emitter } from '../util/events.js';
import { dist } from '../util/math.js';

/**
 * Smart Pose auto-capture state machine.
 *
 *   MONITORING → HOLDING (conditions met, timer running) → COUNTDOWN → CAPTURE → COOLDOWN → MONITORING
 *
 * Conditions must hold for `holdMs` before the "Perfect" countdown starts.
 * Significant subject movement cancels and returns to MONITORING. After a
 * capture, the subject must change pose noticeably before another automatic
 * capture can arm, so the same pose is not shot repeatedly.
 *
 * Events: 'state' {state, progress}, 'capture', 'cancel' {reason}
 */
export class AutoCaptureController extends Emitter {
  constructor(config = AUTO_CAPTURE) {
    super();
    this.config = { ...config, thresholds: { ...config.thresholds } };
    this.state = 'IDLE';
    this.holdStart = 0; this.countdownStart = 0; this.cooldownUntil = 0;
    this.referencePose = null; this.capturedPose = null;
    this.enabled = false;
    this.progress = 0;
  }

  /** Partial update; thresholds are merged so a single override never wipes the others. */
  configure(patch) {
    const { thresholds, ...rest } = patch;
    Object.assign(this.config, rest);
    if (thresholds) this.config.thresholds = { ...this.config.thresholds, ...thresholds };
  }

  setEnabled(on) { this.enabled = on; this.transition(on ? 'MONITORING' : 'IDLE'); }

  transition(state, extra = {}) {
    if (this.state === state) return;
    this.state = state; this.progress = 0;
    this.emit('state', { state, ...extra });
  }

  static poseSignature(subject) {
    if (!subject?.landmarks) return subject ? [{ x: subject.center.x, y: subject.center.y }] : null;
    const b = subject.box;
    return [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26].map((i) => ({ x: (subject.landmarks[i].x - b.x) / Math.max(1e-3, b.w), y: (subject.landmarks[i].y - b.y) / Math.max(1e-3, b.h) }));
  }
  static poseDistance(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let s = 0; for (let i = 0; i < a.length; i++) s += dist(a[i], b[i]); return s / a.length;
  }

  conditionsMet(scores, group) {
    const T = this.config.thresholds;
    return scores.overall >= T.overall && scores.pose >= T.pose && scores.framing >= T.framing && scores.stability >= T.stability && scores.lighting >= T.lighting && (!group || group.stable);
  }

  /**
   * @param {{scores:{overall,pose,framing,stability,lighting}, subject, group, now:number}} s
   */
  update({ scores, subject, group, now }) {
    if (!this.enabled || this.state === 'IDLE') return this.state;
    if (this.state === 'CAPTURING') return this.state;
    if (this.state === 'COOLDOWN') {
      if (now < this.cooldownUntil) return this.state;
      this.transition('MONITORING');
    }
    if (!subject) { if (this.state !== 'MONITORING') { this.cancel('Subject lost'); } return this.state; }

    const sig = AutoCaptureController.poseSignature(subject);
    const samePoseAsLast = this.capturedPose && AutoCaptureController.poseDistance(sig, this.capturedPose) < this.config.requirePoseChange;
    const ok = this.conditionsMet(scores, group) && !samePoseAsLast;

    if (this.state === 'MONITORING') {
      if (ok) { this.holdStart = now; this.referencePose = sig; this.transition('HOLDING'); }
      return this.state;
    }
    const moved = AutoCaptureController.poseDistance(sig, this.referencePose) > this.config.cancelMovement;
    if (this.state === 'HOLDING') {
      if (!ok || moved) { this.cancel(moved ? 'Moved' : 'Conditions changed'); return this.state; }
      const hold = this.config.holdMs + ((group && group.issues?.length && group.stable === false) ? this.config.groupSettleMs : 0);
      this.progress = Math.min(1, (now - this.holdStart) / hold);
      this.emit('state', { state: 'HOLDING', progress: this.progress });
      if (now - this.holdStart >= hold) { this.countdownStart = now; this.transition('COUNTDOWN'); }
      return this.state;
    }
    if (this.state === 'COUNTDOWN') {
      if (moved || scores.stability < this.config.thresholds.stability - 15) { this.cancel('Moved during countdown'); return this.state; }
      this.progress = Math.min(1, (now - this.countdownStart) / this.config.countdownMs);
      this.emit('state', { state: 'COUNTDOWN', progress: this.progress });
      if (now - this.countdownStart >= this.config.countdownMs) {
        this.capturedPose = sig;
        this.transition('CAPTURING');
        this.emit('capture', { scores });
      }
    }
    return this.state;
  }

  /** Call when the capture (auto or manual) has finished. */
  captured(now) { this.cooldownUntil = now + this.config.cooldownMs; this.transition('COOLDOWN'); }

  cancel(reason) { this.referencePose = null; this.transition('MONITORING'); this.emit('cancel', { reason }); }
}
