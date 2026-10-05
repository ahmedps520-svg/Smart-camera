import { toViewPoint } from '../vision/ViewTransform.js';

/**
 * Turns face-mesh results into per-face expression readings in view coordinates:
 * { center, box, smile (0…1), eyesOpen (0…1) }. Used by the smile shutter, the
 * blink guard and burst best-shot selection. Nothing is stored or identified.
 */
export function summarizeExpressions(faces = [], crop = { x: 0, y: 0, w: 1, h: 1 }) {
  return faces.map((f) => {
    const pts = f.landmarks.map((p) => toViewPoint(p, crop));
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
    const b = f.blendshapes || {};
    const smile = ((b.mouthSmileLeft ?? 0) + (b.mouthSmileRight ?? 0)) / 2;
    const blink = ((b.eyeBlinkLeft ?? 0) + (b.eyeBlinkRight ?? 0)) / 2;
    return { center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, smile, eyesOpen: 1 - blink };
  }).filter((e) => e.center.x > 0 && e.center.x < 1 && e.center.y > 0 && e.center.y < 1);
}

/** Lowest eyes-open value among visible faces (1 when there are none). */
export const minEyesOpen = (exprs) => (exprs?.length ? Math.min(...exprs.map((e) => e.eyesOpen)) : 1);

/** Expression of the face nearest a point (e.g. the primary subject's head). */
export function expressionNear(exprs, point) {
  if (!exprs?.length || !point) return exprs?.[0] || null;
  return exprs.reduce((a, b) => (Math.hypot(b.center.x - point.x, b.center.y - point.y) < Math.hypot(a.center.x - point.x, a.center.y - point.y) ? b : a));
}
