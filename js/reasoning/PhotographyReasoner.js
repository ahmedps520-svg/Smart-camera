import { GUIDANCE, COMPOSITION } from '../config/defaults.js';
import { Debouncer, Hysteresis } from './Debouncer.js';
import { validateRecommendation } from './RecommendationValidator.js';

/**
 * Layer 2: local photography reasoning.
 *
 * Input is the structured SceneState assembled by the app (never raw frames):
 * {
 *   mode, scene, tracked, composition, pose, lighting, motion, zoom:{current, presets, advice},
 *   group, scores:{pose, framing, lighting, stability, overall}
 * }
 * Output is a validated, structured Recommendation:
 * { recommendation, confidence, zoom, composition, reason, captureReady, text, arrow, tone, severity }
 *
 * This default implementation is a deterministic rules engine (fast, explainable,
 * runs every analysed frame). Any reasoner, including a local LLM adapter, must
 * implement `reason(state) -> candidate` and will be run through the same
 * validator and debouncer: free-form model output can never reach the camera.
 */
export class RuleBasedReasoner {
  reason(s) {
    const { mode, composition: c, tracked, lighting, motion, zoom, group, pose } = s;
    const hasSubject = !!c?.hasSubject;
    const out = (recommendation, text, extra = {}) => ({ recommendation, text, confidence: 0.6, composition: c?.type, captureReady: false, severity: 1, tone: 'warn', ...extra });

    // 1. Nothing to frame.
    if (!hasSubject) {
      const level = Math.abs(motion?.rollDeg ?? 0) > COMPOSITION.levelToleranceDeg * 1.5;
      const horizonIssue = c?.issues?.find((i) => i.code === 'TILT_UP' || i.code === 'TILT_DOWN');
      if (level && (s.scene === 'landscape' || s.scene === 'architecture' || s.scene === 'beach' || s.scene === 'sunset')) return out('LEVEL_CAMERA', 'Level camera', { reason: 'Horizon is tilted', arrow: (motion.rollDeg > 0 ? '↻' : '↺'), confidence: 0.8, severity: 2 });
      if (horizonIssue) return out(horizonIssue.code, horizonIssue.text, { reason: 'Put the horizon on a third line', arrow: horizonIssue.code === 'TILT_UP' ? '↑' : '↓', confidence: 0.55 });
      if (s.scene === 'landscape' || s.scene === 'beach' || s.scene === 'sunset') {
        if (zoom?.advice?.action === 'ZOOM' && zoom.advice.zoom) return out('ZOOM', `Try ${zoom.advice.zoom}×`, { zoom: zoom.advice.zoom, reason: zoom.advice.reason, confidence: zoom.advice.confidence, tone: 'neutral', severity: 0 });
        return out('PERFECT', level ? 'Level camera' : 'Looks good', { reason: 'Scene framed', tone: level ? 'warn' : 'good', captureReady: !level, confidence: 0.5, severity: 0 });
      }
      if (s.scene === 'architecture' && c?.symmetry != null && c.symmetry < 0.55) return out('MOVE_LEFT', 'Centre for symmetry', { reason: 'Facade is off-centre', tone: 'neutral', confidence: 0.4, severity: 0 });
      if (mode === 'pose') return out('LOOKING', 'Looking for a person', { reason: 'No person detected', tone: 'neutral', severity: 0, confidence: 0.9 });
      if (lighting && lighting.tone === 'warn') return out(lighting.code, lighting.advice, { reason: lighting.advice, confidence: 0.6, severity: 0 });
      return out('NO_SUBJECT', 'Point at a subject', { reason: 'No subject detected', tone: 'neutral', severity: 0, confidence: 0.9 });
    }

    const issues = [...(c.issues || []), ...(group?.issues || [])];
    const find = (...codes) => issues.find((i) => codes.includes(i.code));

    // 2. Hard framing problems: subject spilling out, group cut off.
    const cut = find('TOO_BIG', 'GROUP_BACK');
    if (cut) return out('MOVE_BACK', 'Move back', { reason: 'Subject does not fit the frame', arrow: '↓', confidence: 0.85, severity: 2 });
    const gEdge = find('GROUP_EDGE', 'GROUP_HEAD_CUT');
    if (gEdge) return out('GROUP_EDGE', gEdge.text, { reason: gEdge.text, confidence: 0.8, severity: 2 });
    const edge = find('EDGE_LEFT', 'EDGE_RIGHT');
    if (edge) return out('SUBJECT_EDGE', 'Subject too close to edge', { reason: edge.text, arrow: edge.code === 'EDGE_LEFT' ? '←' : '→', confidence: 0.8, severity: 2 });
    const head = find('MORE_HEADROOM');
    if (head) return out('MORE_HEADROOM', 'More headroom', { reason: 'Head is touching the top', arrow: '↑', confidence: 0.8, severity: 2 });

    // 3. Level (stricter for architecture/landscape).
    const roll = motion?.rollDeg ?? 0;
    const levelTol = (s.scene === 'architecture' || s.scene === 'landscape') ? COMPOSITION.levelToleranceDeg * 1.5 : COMPOSITION.levelToleranceDeg * 3;
    if (s._hyst.test('level', Math.abs(roll), levelTol)) return out('LEVEL_CAMERA', 'Level camera', { reason: `Tilted ${roll.toFixed(0)}°`, arrow: roll > 0 ? '↻' : '↺', confidence: 0.8, severity: 1 });

    // 4. Position (largest axis first), with hysteresis on the deviation magnitude.
    const { dx, dy } = c.deviation;
    const tol = COMPOSITION.tolerances.position;
    const xOn = s._hyst.test('x', Math.abs(dx), tol), yOn = s._hyst.test('y', Math.abs(dy), tol);
    if (xOn && (Math.abs(dx) >= Math.abs(dy) || !yOn)) {
      // Subject right of ideal → pan/move the camera right so the subject slides left in frame.
      return dx > 0 ? out('MOVE_RIGHT', 'Move right', { reason: 'Subject is left of the ideal spot', arrow: '→', confidence: Math.min(0.95, 0.5 + Math.abs(dx) * 3) })
        : out('MOVE_LEFT', 'Move left', { reason: 'Subject is right of the ideal spot', arrow: '←', confidence: Math.min(0.95, 0.5 + Math.abs(dx) * 3) });
    }
    if (yOn) {
      return dy > 0 ? out('TILT_DOWN', 'Tilt down', { reason: 'Subject sits low in the frame', arrow: '↓', confidence: Math.min(0.95, 0.5 + Math.abs(dy) * 3) })
        : out('TILT_UP', 'Tilt up', { reason: 'Subject sits high in the frame', arrow: '↑', confidence: Math.min(0.95, 0.5 + Math.abs(dy) * 3) });
    }
    const less = find('LESS_HEADROOM');
    if (less && s._hyst.test('headroom', less.amount ?? 0.05, COMPOSITION.tolerances.headroom)) return out('LESS_HEADROOM', 'Tilt down', { reason: 'Too much headroom', arrow: '↓', confidence: 0.6 });

    // 5. Size / zoom.
    const za = zoom?.advice;
    if (za?.action === 'ZOOM' && za.zoom) return out('ZOOM', `Zoom to ${za.zoom}×`, { zoom: za.zoom, reason: za.reason, confidence: za.confidence, tone: 'neutral' });
    if (za?.action === 'CLOSER') return out('MOVE_CLOSER', 'Move closer', { reason: za.reason, arrow: '↑', confidence: za.confidence });
    if (za?.action === 'BACK') return out('MOVE_BACK', 'Move back', { reason: za.reason, arrow: '↓', confidence: za.confidence });
    const spread = find('GROUP_SPREAD');
    if (spread) return out('GROUP_SPREAD', spread.text, { reason: spread.text, confidence: 0.6 });

    // 6. Lighting.
    if (lighting?.code === 'BACKLIT') return out('BACKLIT', 'Subject is backlit', { reason: 'Background much brighter than subject', confidence: 0.7 });
    if (lighting?.code === 'SUBJECT_DARK') return out('TURN_TO_LIGHT', 'Turn toward the light', { reason: 'Face is underexposed', confidence: 0.6 });
    if (lighting?.code === 'TOO_DARK') return out('TOO_DARK', lighting.isNight ? 'Hold still — very dark' : 'Too dark', { reason: 'Low light', confidence: 0.7 });
    if (lighting?.code === 'TOO_BRIGHT') return out('TOO_BRIGHT', 'Too bright', { reason: 'Highlights clipping', confidence: 0.6 });

    // 7. Pose-specific coaching.
    if (mode === 'pose' && pose) {
      if (pose.components.faceVisible < 0.5 || pose.issues.includes('Face turned away')) return out('FACE_CAMERA', 'Face the camera', { reason: 'Face not clearly visible', confidence: 0.7 });
      if (pose.components.stability < 0.4) return out('HOLD_STILL', 'Hold still', { reason: 'Subject is moving', confidence: 0.8, tone: 'neutral' });
    }
    if ((motion?.stability ?? 1) < 0.35) return out('HOLD_STILL', 'Hold still', { reason: 'Camera is moving', confidence: 0.7, tone: 'neutral' });

    // 8. All good.
    const groupOk = tracked.count > 1;
    const ready = (s.scores?.framing ?? 0) >= 70;
    if (groupOk) return out('EVERYONE_IN_FRAME', ready ? 'Everyone is in frame' : 'Hold it there', { reason: 'Group framed', tone: 'good', captureReady: ready && group?.stable, confidence: 0.8, severity: 0 });
    if (lighting?.code === 'LIGHT_GREAT' && (s.scores?.framing ?? 0) >= 85) return out('PERFECT', 'Perfect framing', { reason: 'Framing and light are good', tone: 'good', captureReady: true, confidence: 0.9, severity: 0 });
    return out('PERFECT', ready ? 'Perfect framing' : 'Nice', { reason: 'Framing is good', tone: 'good', captureReady: ready, confidence: 0.75, severity: 0 });
  }
}

/**
 * Orchestrates the reasoner: validates its output, applies debouncing, and
 * exposes the current (stable) recommendation. Swap `reasoner` for another
 * implementation (e.g. a local model adapter) without touching the UI.
 */
export class PhotographyReasoner {
  constructor(reasoner = new RuleBasedReasoner()) {
    this.reasoner = reasoner;
    this.debouncer = new Debouncer({ minHoldMs: GUIDANCE.minHoldMs });
    this.hyst = new Hysteresis({ enter: GUIDANCE.enterRatio, exit: GUIDANCE.exitRatio });
    this.lastRaw = null;
  }

  setReasoner(r) { this.reasoner = r; this.debouncer.reset(); }

  /** @returns {{stable:Object|null, raw:Object}} */
  update(state, now) {
    let candidate;
    try { candidate = this.reasoner.reason({ ...state, _hyst: this.hyst }); } catch (e) { console.error('[reasoner]', e); candidate = null; }
    const allowed = state.zoom?.presets?.map((p) => p.factor) || [];
    const { value } = validateRecommendation(candidate, allowed);
    value.code = value.recommendation;
    this.lastRaw = value;
    const stable = this.debouncer.push(value.recommendation === 'NONE' ? null : value, now);
    return { stable, raw: value };
  }

  reset() { this.debouncer.reset(); this.hyst.reset(); }
}
