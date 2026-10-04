import { GOVERNOR, SCHEDULE } from '../config/defaults.js';
import { Ring } from '../util/smoothing.js';

/**
 * Software thermal/performance management. Browsers expose no thermal state, so
 * we infer load from inference latency and dropped frames and adapt the analysis
 * schedule (frame skipping, lower analysis resolution, fewer model runs).
 * The camera preview itself is never throttled.
 *
 * tier: 'high' | 'balanced' | 'low';  thermal: 'nominal' | 'warm' | 'hot'
 */
export class PerformanceGovernor {
  constructor({ mode = 'auto' } = {}) {
    this.mode = mode;
    this.tier = 'balanced';
    this.thermal = 'nominal';
    this.inference = new Ring(GOVERNOR.sampleWindow);
    this.frameGap = new Ring(GOVERNOR.sampleWindow);
    this.lastStepDown = 0; this.lastGoodSince = 0;
    this.battery = null;
    this.lowPower = false;
    navigator.getBattery?.().then((b) => {
      this.battery = b;
      const upd = () => { this.lowPower = !b.charging && b.level <= 0.2; };
      b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd); upd();
    }).catch(() => {});
  }

  setMode(mode) { this.mode = mode; if (mode !== 'auto') this.tier = mode; }

  recordInference(ms) { this.inference.push(ms); }
  recordFrameGap(ms) { this.frameGap.push(ms); }

  /** Call once per analysed frame. Returns the current schedule. */
  evaluate(now) {
    if (this.mode === 'auto' && this.inference.length >= GOVERNOR.sampleWindow * 0.8) {
      const avg = this.inference.mean();
      const expectedGap = 1000 / SCHEDULE[this.tier].maxFps;
      const dropped = this.frameGap.buf.filter((g) => g > expectedGap * 1.8).length / Math.max(1, this.frameGap.length);
      const hot = avg > GOVERNOR.slowInferenceMs || dropped > GOVERNOR.droppedFrameRatio;
      if (hot || this.lowPower) {
        if (now - this.lastStepDown > 4000) {
          this.tier = this.tier === 'high' ? 'balanced' : 'low';
          this.lastStepDown = now; this.lastGoodSince = now;
          this.inference.clear(); this.frameGap.clear();
        }
        this.thermal = this.tier === 'low' ? 'hot' : 'warm';
      } else if (avg < GOVERNOR.fastInferenceMs && dropped < 0.1) {
        if (!this.lastGoodSince) this.lastGoodSince = now;
        if (now - this.lastGoodSince > GOVERNOR.stepUpAfterMs && this.tier !== 'high') {
          this.tier = this.tier === 'low' ? 'balanced' : 'high';
          this.lastGoodSince = now; this.inference.clear(); this.frameGap.clear();
        }
        this.thermal = 'nominal';
      } else {
        this.lastGoodSince = 0;
        if (this.thermal === 'hot') this.thermal = 'warm';
      }
    }
    return SCHEDULE[this.tier];
  }

  get analysisWidth() { return GOVERNOR.analysisWidth[this.tier]; }
  get stats() { return { tier: this.tier, thermal: this.thermal, inferenceMs: Math.round(this.inference.mean()), lowPower: this.lowPower }; }
}
