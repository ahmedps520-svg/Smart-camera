/**
 * Strict schema for anything that may influence the camera. Every reasoner
 * (rule-based or a local LLM adapter) must pass through here; invalid output is
 * rejected and replaced with a safe no-op so free-form text can never drive
 * capture or zoom.
 */
export const RECOMMENDATIONS = new Set([
  'MOVE_LEFT', 'MOVE_RIGHT', 'MOVE_CLOSER', 'MOVE_BACK', 'TILT_UP', 'TILT_DOWN', 'LEVEL_CAMERA', 'ZOOM',
  'MORE_HEADROOM', 'LESS_HEADROOM', 'SUBJECT_EDGE', 'TURN_TO_LIGHT', 'TOO_DARK', 'TOO_BRIGHT', 'BACKLIT', 'HOLD_STILL',
  'FACE_CAMERA', 'GROUP_EDGE', 'GROUP_BACK', 'GROUP_SPREAD', 'GROUP_OK', 'EVERYONE_IN_FRAME', 'LIGHTING_GOOD',
  'PERFECT', 'NO_SUBJECT', 'LOOKING', 'NONE',
]);
export const COMPOSITIONS = new Set(['RULE_OF_THIRDS', 'CENTER', 'SYMMETRY', 'HORIZON', 'NEGATIVE_SPACE', 'GROUP']);

export const SAFE_NOOP = Object.freeze({ recommendation: 'NONE', confidence: 0, zoom: null, composition: 'RULE_OF_THIRDS', reason: '', captureReady: false, severity: 0 });

/**
 * @param {any} r candidate recommendation
 * @param {number[]} allowedZooms zoom presets the device supports
 * @returns {{ok:boolean, value:Object, errors:string[]}}
 */
export function validateRecommendation(r, allowedZooms = []) {
  const errors = [];
  if (!r || typeof r !== 'object') return { ok: false, value: { ...SAFE_NOOP }, errors: ['not an object'] };
  const out = { ...SAFE_NOOP };
  if (RECOMMENDATIONS.has(r.recommendation)) out.recommendation = r.recommendation; else errors.push(`bad recommendation ${r.recommendation}`);
  const c = Number(r.confidence); if (Number.isFinite(c) && c >= 0 && c <= 1) out.confidence = c; else errors.push('bad confidence');
  if (r.zoom == null) out.zoom = null;
  else { const z = Number(r.zoom); if (Number.isFinite(z) && z > 0 && z <= 15 && (!allowedZooms.length || allowedZooms.some((a) => Math.abs(a - z) < 1e-6))) out.zoom = z; else errors.push(`zoom ${r.zoom} not allowed`); }
  if (COMPOSITIONS.has(r.composition)) out.composition = r.composition; else if (r.composition != null) errors.push('bad composition');
  out.reason = typeof r.reason === 'string' ? r.reason.slice(0, 120) : '';
  out.captureReady = r.captureReady === true;
  out.severity = Number.isInteger(r.severity) ? Math.max(0, Math.min(3, r.severity)) : 0;
  if (typeof r.text === 'string') out.text = r.text.slice(0, 60);
  if (typeof r.arrow === 'string') out.arrow = r.arrow.slice(0, 2);
  if (typeof r.tone === 'string' && ['good', 'warn', 'bad', 'neutral'].includes(r.tone)) out.tone = r.tone;
  if (errors.length && !RECOMMENDATIONS.has(r.recommendation)) return { ok: false, value: { ...SAFE_NOOP }, errors };
  return { ok: errors.length === 0, value: out, errors };
}
