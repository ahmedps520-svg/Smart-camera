import { Emitter } from '../util/events.js';
import { EMA, Ring } from '../util/smoothing.js';
import { clamp01, deg } from '../util/math.js';

/**
 * Camera roll from a gravity reading, in the current screen frame.
 *
 * Browsers disagree on the sign of accelerationIncludingGravity: iOS Safari
 * reports the opposite sign to Android/Chrome, which naively gives ~180° on an
 * upright iPhone. The angle is therefore folded into −90…90°, which makes the
 * result identical on both platforms (a camera is never used upside down).
 *
 * Returns { rollDeg, flat }: flat is true when the phone points mostly up or
 * down, where roll is meaningless.
 */
export function rollFromGravity(x, y, z, screenAngle = 0) {
  const a = ((screenAngle % 360) + 360) % 360;
  if (a === 90) [x, y] = [-y, x];
  else if (a === 270) [x, y] = [y, -x];
  else if (a === 180) [x, y] = [-x, -y];
  const planar = Math.hypot(x, y);
  const g = Math.hypot(x, y, z) || 9.81;
  let roll = deg(Math.atan2(x, y));
  if (roll > 90) roll -= 180;
  else if (roll < -90) roll += 180;
  return { rollDeg: roll, flat: planar / g < 0.45 };
}

/**
 * Core Motion analogue for the web: reads DeviceMotion (gravity + rotation rate)
 * to produce camera roll, a level flag and a stability score. Falls back to
 * DeviceOrientation, and to a neutral reading when no sensors are available.
 *
 * Emits 'motion' { rollDeg, stability, level, flat, available }
 */
export class MotionSensor extends Emitter {
  constructor({ levelToleranceDeg = 1.5, hysteresisDeg = 0.8 } = {}) {
    super();
    this.roll = new EMA(0.2);
    this.rot = new Ring(20);
    this.acc = new Ring(20);
    this.available = false;
    this.level = false;
    this.levelTol = levelToleranceDeg;
    this.hyst = hysteresisDeg;
    this.state = { rollDeg: 0, stability: 1, level: true, flat: false, available: false };
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
    const { rollDeg, flat } = rollFromGravity(g.x, g.y, g.z ?? 0, this.screenAngle());
    // Avoid EMA wrap-around when the folded angle jumps across ±90.
    if (this.roll.value != null && Math.abs(rollDeg - this.roll.value) > 60) this.roll.reset(rollDeg);
    this.roll.push(rollDeg);
    this.flat = flat;
    const rr = e.rotationRate;
    if (rr && rr.alpha != null) this.rot.push(Math.hypot(rr.alpha, rr.beta, rr.gamma));
    const a = e.acceleration;
    if (a && a.x != null) this.acc.push(Math.hypot(a.x, a.y, a.z));
    this.publish();
  }

  onOrientation(e) {
    if (this.available || e.gamma == null) return; // devicemotion is preferred
    const ang = ((this.screenAngle() % 360) + 360) % 360;
    let roll = ang === 0 ? -e.gamma : ang === 90 ? 90 - e.beta : ang === 270 ? e.beta - 90 : e.gamma;
    if (roll > 90) roll -= 180; else if (roll < -90) roll += 180;
    this.roll.push(roll);
    this.flat = Math.abs(e.beta ?? 90) < 25;
    this.publish(true);
  }

  publish(fromOrientation = false) {
    const rollDeg = this.flat ? 0 : (this.roll.value ?? 0);
    const tol = this.level ? this.levelTol + this.hyst : this.levelTol;
    this.level = this.flat || Math.abs(rollDeg) <= tol;
    // Stability: 1 when rotation rate < 4 deg/s and no linear acceleration, 0 at > 45 deg/s.
    const rot = this.rot.mean();
    const acc = this.acc.mean();
    const stability = fromOrientation ? 0.9 : clamp01(1 - Math.max((rot - 4) / 41, (acc - 0.2) / 1.3));
    this.state = { rollDeg, stability, level: this.level, flat: !!this.flat, available: true };
    this.emit('motion', this.state);
  }

  /** Current reading (neutral if the device has no sensors). */
  read() { return this.state; }
}
