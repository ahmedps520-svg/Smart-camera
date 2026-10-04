import { Emitter } from '../util/events.js';
import { EMA, Ring } from '../util/smoothing.js';
import { clamp01, deg } from '../util/math.js';

/**
 * Core Motion analogue for the web: reads DeviceMotion (gravity + rotation rate)
 * to produce camera roll, pitch, a level flag and a stability score. Falls back
 * to DeviceOrientation, and to a neutral reading when no sensors are available.
 *
 * Emits 'motion' { rollDeg, pitchDeg, stability, level, available }
 */
export class MotionSensor extends Emitter {
  constructor({ levelToleranceDeg = 1.5, hysteresisDeg = 0.8 } = {}) {
    super();
    this.roll = new EMA(0.25);
    this.pitch = new EMA(0.25);
    this.rot = new Ring(20);
    this.acc = new Ring(20);
    this.available = false;
    this.level = false;
    this.levelTol = levelToleranceDeg;
    this.hyst = hysteresisDeg;
    this.state = { rollDeg: 0, pitchDeg: 0, stability: 1, level: true, available: false };
    this._onMotion = this.onMotion.bind(this);
    this._onOrientation = this.onOrientation.bind(this);
  }

  /** Must be called from a user gesture on iOS (permission prompt). */
  async start() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch { /* not granted or not a gesture */ }
    if ('DeviceMotionEvent' in window) window.addEventListener('devicemotion', this._onMotion, { passive: true });
    if ('DeviceOrientationEvent' in window) window.addEventListener('deviceorientation', this._onOrientation, { passive: true });
    return true;
  }

  stop() {
    window.removeEventListener('devicemotion', this._onMotion);
    window.removeEventListener('deviceorientation', this._onOrientation);
  }

  screenAngle() {
    const a = screen.orientation?.angle ?? window.orientation ?? 0;
    return typeof a === 'number' ? a : 0;
  }

  onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    this.available = true;
    let { x, y, z } = g;
    // Rotate gravity into the current screen frame so landscape works too.
    const ang = this.screenAngle();
    if (ang === 90) { [x, y] = [-y, x]; } else if (ang === 270 || ang === -90) { [x, y] = [y, -x]; } else if (ang === 180) { [x, y] = [-x, -y]; }
    // roll: 0 when upright; sign chosen so a clockwise device tilt gives a negative roll.
    const rollDeg = deg(Math.atan2(x, y));
    const pitchDeg = deg(Math.atan2(z, Math.hypot(x, y)));
    this.roll.push(rollDeg);
    this.pitch.push(pitchDeg);
    const rr = e.rotationRate;
    if (rr && rr.alpha != null) this.rot.push(Math.hypot(rr.alpha, rr.beta, rr.gamma));
    const a = e.acceleration;
    if (a && a.x != null) this.acc.push(Math.hypot(a.x, a.y, a.z));
    this.publish();
  }

  onOrientation(e) {
    if (this.available || e.gamma == null) return; // devicemotion is preferred
    const ang = this.screenAngle();
    let roll = ang === 0 ? e.gamma : ang === 90 ? e.beta - 90 : ang === 270 ? 90 - e.beta : -e.gamma;
    this.roll.push(roll);
    this.pitch.push((e.beta ?? 90) - 90);
    this.publish(true);
  }

  publish(fromOrientation = false) {
    const rollDeg = this.roll.value ?? 0;
    const pitchDeg = this.pitch.value ?? 0;
    const tol = this.level ? this.levelTol + this.hyst : this.levelTol;
    this.level = Math.abs(rollDeg) <= tol;
    // Stability: 1 when rotation rate < 3 deg/s and no linear acceleration, 0 at > 40 deg/s.
    const rot = this.rot.mean();
    const acc = this.acc.mean();
    const stability = fromOrientation ? 0.9 : clamp01(1 - Math.max((rot - 3) / 37, (acc - 0.15) / 1.2));
    this.state = { rollDeg, pitchDeg, stability, level: this.level, available: true };
    this.emit('motion', this.state);
  }

  /** Current reading (neutral if the device has no sensors). */
  read() { return this.state; }
}
