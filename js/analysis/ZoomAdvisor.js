import { ZOOM } from '../config/defaults.js';
import { clamp } from '../util/math.js';

/**
 * Local zoom/lens recommendation. Considers subject size vs. the composition's
 * target, scene, the lens presets the device genuinely offers and the current
 * zoom. Prefers optical presets over digital crops. Hysteresis prevents the
 * recommendation from oscillating.
 */
export class ZoomAdvisor {
  constructor(config = ZOOM) { this.config = config; this.current = null; this.since = 0; }

  /**
   * @returns {{zoom:number|null, optical:boolean, reason:string, confidence:number, action:'ZOOM'|'CLOSER'|'BACK'|'NONE'}}
   */
  recommend({ composition, scene, presets, currentZoom, tracked, now = 0 }) {
    const C = this.config;
    if (!presets?.length) return { zoom: null, optical: false, reason: 'No lens data', confidence: 0, action: 'NONE' };
    const factors = presets.map((p) => p.factor);
    const minP = Math.min(...factors), maxP = Math.max(...factors);
    let desired = currentZoom, reason = '', confidence = 0.5, action = 'NONE';

    if (composition?.hasSubject && composition.sizeRatio) {
      const r = composition.sizeRatio; // current / target height
      if (r < 1 - C.hysteresis || r > 1 + C.hysteresis * 1.5) {
        desired = clamp(currentZoom / r, minP, C.maxDigital);
        confidence = clamp(Math.abs(1 - r), 0.3, 0.95);
        reason = r < 1 ? 'Subject is small in the frame' : 'Subject fills too much of the frame';
      }
    } else if (!composition?.hasSubject) {
      if ((scene === 'landscape' || scene === 'architecture' || scene === 'beach') && minP < 1 && currentZoom <= 1.01) { desired = minP; reason = 'Wide scene — ultra wide shows more'; confidence = 0.55; }
      if ((scene === 'food' || scene === 'product') && factors.includes(2) && currentZoom < 1.5) { desired = 2; reason = 'Less distortion for close subjects'; confidence = 0.5; }
    }

    // Snap to the nearest preset, preferring optical ones when close.
    let best = presets.reduce((a, b) => (Math.abs(b.factor - desired) < Math.abs(a.factor - desired) ? b : a));
    const optical = presets.filter((p) => p.optical).reduce((a, b) => (!a || Math.abs(b.factor - desired) < Math.abs(a.factor - desired) ? b : a), null);
    if (optical && Math.abs(optical.factor - desired) / desired < 0.3) best = optical;

    if (reason && composition?.hasSubject) {
      if (desired > maxP * 1.3) { action = 'CLOSER'; reason = 'Move closer'; }
      else if (desired < minP * 0.75 && currentZoom <= minP * 1.01) { action = 'BACK'; reason = 'Move back'; }
      else if (Math.abs(best.factor - currentZoom) / currentZoom > C.hysteresis) action = 'ZOOM';
    } else if (reason && Math.abs(best.factor - currentZoom) / currentZoom > C.hysteresis) action = 'ZOOM';

    // Temporal hysteresis: a new suggestion must persist ~600 ms before it is surfaced.
    const key = `${action}:${best.factor}`;
    if (this.current?.key !== key) { this.current = { key, since: now }; }
    const stable = now - this.current.since >= 600;
    const out = { zoom: action === 'ZOOM' ? best.factor : null, optical: !!best.optical, reason, confidence, action: stable ? action : 'NONE', suggested: best.factor };
    return out;
  }
}
