import { COMPOSITION } from '../config/defaults.js';
import { clamp, clamp01, toleranceScore, targetScore } from '../util/math.js';

/**
 * Local composition engine. Chooses the most sensible composition for the
 * detected scene and evaluates the current framing against it.
 *
 * Output:
 * {
 *   type, targetBox, idealCenter, deviation:{dx,dy}, sizeRatio, headroom,
 *   framingScore (0..100), issues:[{code, severity, text}], horizon:{y,score}|null,
 *   symmetry:number|null, scores:{position,size,headroom,edges,level,horizon,clutter}
 * }
 */
export class CompositionEngine {
  constructor(config = COMPOSITION) { this.config = config; this.lastThirdX = null; }

  static compositionFor(scene, tracked) {
    if (tracked.count > 1) return 'GROUP';
    if (tracked.primary) {
      if (scene === 'product' || scene === 'food') return 'CENTER';
      if (scene === 'architecture') return 'SYMMETRY';
      return 'RULE_OF_THIRDS';
    }
    switch (scene) {
      case 'landscape': case 'beach': case 'sunset': return 'HORIZON';
      case 'architecture': return 'SYMMETRY';
      case 'product': case 'food': return 'CENTER';
      case 'vehicle': return 'NEGATIVE_SPACE';
      default: return 'RULE_OF_THIRDS';
    }
  }

  /** Row (0..1) with the strongest horizontal edge — a cheap horizon estimate. */
  static estimateHorizon(img) {
    if (!img) return null;
    const { data, width: w, height: h } = img;
    const rows = new Float32Array(h);
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x += 2) { const i = (y * w + x) * 4; s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; } rows[y] = s / (w / 2); }
    let best = -1, bestY = -1;
    for (let y = Math.floor(h * 0.15); y < Math.floor(h * 0.85); y++) {
      const g = Math.abs(rows[y + 2] - rows[y - 2]);
      if (g > best) { best = g; bestY = y; }
    }
    if (best < 14) return null; // no clear horizon
    return { y: bestY / h, strength: Math.min(1, best / 60) };
  }

  /** Left/right mirror similarity (1 = perfectly symmetric). */
  static symmetry(img) {
    if (!img) return null;
    const { data, width: w, height: h } = img;
    let diff = 0, n = 0;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w / 2; x += 2) {
      const a = (y * w + x) * 4, b = (y * w + (w - 1 - x)) * 4;
      diff += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]); n += 3;
    }
    return clamp01(1 - (diff / n) / 90);
  }

  /** Background clutter proxy: edge density outside the subject box. */
  static clutter(img, box) {
    if (!img) return 0;
    const { data, width: w, height: h } = img;
    let e = 0, n = 0;
    for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
      if (box && x / w > box.x && x / w < box.x + box.w && y / h > box.y && y / h < box.y + box.h) continue;
      const i = (y * w + x) * 4, r = (y * w + x + 1) * 4, d = ((y + 1) * w + x) * 4;
      e += Math.abs(data[i + 1] - data[r + 1]) + Math.abs(data[i + 1] - data[d + 1]); n++;
    }
    return n ? clamp01((e / n) / 40) : 0;
  }

  evaluate({ tracked, scene, motion, pixels, objects = [], selfie = false }) {
    const C = this.config;
    const type = CompositionEngine.compositionFor(scene, tracked);
    const issues = [];
    const scores = {};
    const rollDeg = motion?.flat ? 0 : (motion?.rollDeg ?? 0);
    const levelWeightHigh = scene === 'landscape' || scene === 'architecture' || scene === 'beach' || scene === 'sunset' || type === 'HORIZON' || type === 'SYMMETRY';
    scores.level = toleranceScore(rollDeg, C.levelToleranceDeg, levelWeightHigh ? 4 : 8);
    if (Math.abs(rollDeg) > C.levelToleranceDeg * (levelWeightHigh ? 1.5 : 3)) issues.push({ code: 'LEVEL', severity: levelWeightHigh ? 2 : 1, text: 'Level camera' });

    let subjectBox = null, subjectIsGroup = false;
    if (type === 'GROUP' && tracked.groupBox) { subjectBox = tracked.groupBox; subjectIsGroup = true; }
    else if (tracked.primary) subjectBox = tracked.primary.smoothBox || tracked.primary.box;
    else if (type === 'NEGATIVE_SPACE' || type === 'CENTER') {
      const o = objects.filter((o) => o.label !== 'person').sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
      if (o) subjectBox = o.box;
    }

    let horizon = null, symmetry = null;
    if (type === 'HORIZON' || scene === 'landscape' || scene === 'beach' || scene === 'sunset') horizon = CompositionEngine.estimateHorizon(pixels);
    if (type === 'SYMMETRY') symmetry = CompositionEngine.symmetry(pixels);
    const clutter = CompositionEngine.clutter(pixels, subjectBox);
    scores.clutter = 1 - clutter * 0.5;

    // ---------- No subject: scene-level composition only ----------
    if (!subjectBox) {
      let framing = scores.level;
      if (horizon) {
        const nearest = C.horizon.preferredRows.reduce((a, b) => (Math.abs(b - horizon.y) < Math.abs(a - horizon.y) ? b : a));
        scores.horizon = toleranceScore(horizon.y - nearest, C.horizon.tolerance, 3);
        if (scores.horizon < 0.6) issues.push({ code: horizon.y < nearest ? 'TILT_DOWN' : 'TILT_UP', severity: 1, text: horizon.y < nearest ? 'Tilt down' : 'Tilt up', amount: Math.abs(horizon.y - nearest) });
        framing = scores.level * 0.55 + scores.horizon * 0.45;
      } else if (type === 'SYMMETRY' && symmetry != null) {
        scores.symmetry = symmetry;
        framing = scores.level * 0.6 + symmetry * 0.4;
      }
      const target = type === 'CENTER' ? { x: 0.3, y: 0.3, w: 0.4, h: 0.4 } : null;
      return { type, targetBox: target, idealCenter: null, deviation: { dx: 0, dy: 0 }, sizeRatio: 1, headroom: null, framingScore: Math.round(framing * 100), issues, horizon, symmetry, clutter, scores, hasSubject: false };
    }

    // ---------- Subject present ----------
    const cx = subjectBox.x + subjectBox.w / 2, cy = subjectBox.y + subjectBox.h / 2;
    const primary = tracked.primary;
    let idealX = 0.5, idealY = 0.5, targetH = subjectBox.h;
    const shot = subjectIsGroup ? 'group' : (primary?.shotType || 'half');

    if (type === 'RULE_OF_THIRDS') {
      // Lead room: a subject looking toward image-left sits on the right third, and vice versa.
      // Selfies are centred horizontally: that is how people frame themselves.
      const facing = primary?.facing ?? 0;
      let thirdX;
      if (selfie) thirdX = 0.5;
      else if (Math.abs(facing) > 0.25) thirdX = facing < 0 ? C.thirds[1] : C.thirds[0];
      else {
        thirdX = this.lastThirdX ?? (cx < 0.5 ? C.thirds[0] : C.thirds[1]);
        // Switch thirds only when the subject has clearly crossed the centre line.
        if (this.lastThirdX != null && Math.abs(cx - 0.5) > 0.12) thirdX = cx < 0.5 ? C.thirds[0] : C.thirds[1];
      }
      if (!selfie) this.lastThirdX = thirdX;
      idealX = thirdX;
      // Vertical: for close/half shots put the eyes near the upper third; for full-body centre the body with headroom.
      if (primary && (shot === 'closeUp' || shot === 'half')) {
        const eyeOffset = primary.head.y - cy; // head relative to box centre
        idealY = C.thirds[0] - eyeOffset + (primary.faceH || 0) * 0.3;
      } else {
        // Full / three-quarter body: keep ideal headroom above the head, body filling downward.
        idealY = Math.max(0.5, C.headroom.ideal + subjectBox.h / 2);
      }
      targetH = Math.min(0.92, C.subjectHeight[shot] ?? 0.6);
    } else if (type === 'CENTER' || type === 'SYMMETRY') {
      idealX = 0.5; idealY = type === 'SYMMETRY' ? 0.5 : 0.52;
      targetH = subjectIsGroup ? C.subjectHeight.group : clamp(subjectBox.h, 0.4, 0.7);
      if (symmetry != null) scores.symmetry = symmetry;
    } else if (type === 'GROUP') {
      idealX = 0.5; idealY = Math.max(0.5, C.headroom.ideal + subjectBox.h / 2); targetH = C.subjectHeight.group;
    } else if (type === 'NEGATIVE_SPACE') {
      // Without a reliable heading, favour the third that leaves space on the side the object points away from.
      idealX = cx < 0.5 ? C.thirds[0] : C.thirds[1]; idealY = 0.5; targetH = clamp(subjectBox.h, 0.35, 0.6);
    }
    idealX = clamp(idealX, subjectBox.w / 2 + C.edgeMargin, 1 - subjectBox.w / 2 - C.edgeMargin);
    idealY = clamp(idealY, subjectBox.h / 2 + C.edgeMargin, 1 - subjectBox.h / 2 - C.edgeMargin);

    const dx = cx - idealX, dy = cy - idealY;
    scores.position = toleranceScore(Math.hypot(dx, dy), C.tolerances.position, 5);

    // Size: only penalise when clearly too small or spilling out of the frame.
    const sizeRatio = subjectBox.h / targetH;
    const cutTop = subjectBox.y <= 0.005, cutBottom = subjectBox.y + subjectBox.h >= 0.995;
    const cutLeft = subjectBox.x <= 0.005, cutRight = subjectBox.x + subjectBox.w >= 0.995;
    const tooBig = subjectBox.h > 0.97 || subjectBox.w > 0.97;
    scores.size = sizeRatio < 1 ? clamp01(1 - (1 - sizeRatio - C.tolerances.size) / 0.5) : (tooBig ? 0.4 : 1);
    if (sizeRatio < 0.55) issues.push({ code: 'TOO_SMALL', severity: 1, text: 'Move closer', amount: 1 - sizeRatio });
    if (tooBig && (cutLeft || cutRight) && shot !== 'closeUp') issues.push({ code: 'TOO_BIG', severity: 2, text: 'Move back' });

    // Headroom (people only).
    let headroom = null;
    if (primary && !subjectIsGroup) {
      headroom = primary.headTopY;
      const hr = C.headroom;
      scores.headroom = headroom < hr.min ? clamp01(headroom / hr.min) : headroom > hr.max ? clamp01(1 - (headroom - hr.max) / 0.25) : 1;
      if (shot !== 'closeUp' && headroom < hr.min * 0.6) issues.push({ code: 'MORE_HEADROOM', severity: 2, text: 'More headroom' });
      else if (shot !== 'full' && headroom > hr.max + C.tolerances.headroom) issues.push({ code: 'LESS_HEADROOM', severity: 1, text: 'Tilt down', amount: headroom - hr.max });
    } else scores.headroom = 1;

    // Edges.
    const nearEdge = (cutLeft || cutRight) && !tooBig;
    scores.edges = nearEdge ? 0.45 : 1;
    if (nearEdge) issues.push({ code: cutLeft ? 'EDGE_LEFT' : 'EDGE_RIGHT', severity: 2, text: 'Subject too close to the edge' });

    // Movement issue from deviation (hysteresis is applied downstream by the reasoner).
    if (Math.abs(dx) > C.tolerances.position) issues.push({ code: dx > 0 ? 'MOVE_RIGHT' : 'MOVE_LEFT', severity: 1, text: dx > 0 ? 'Move right' : 'Move left', amount: Math.abs(dx) });
    if (Math.abs(dy) > C.tolerances.position) issues.push({ code: dy > 0 ? 'TILT_DOWN' : 'TILT_UP', severity: 1, text: dy > 0 ? 'Tilt down' : 'Tilt up', amount: Math.abs(dy) });

    // Horizon for landscapes with a person in them.
    if (horizon) { const nearest = C.horizon.preferredRows.reduce((a, b) => (Math.abs(b - horizon.y) < Math.abs(a - horizon.y) ? b : a)); scores.horizon = toleranceScore(horizon.y - nearest, C.horizon.tolerance, 3); }

    const w = { position: 0.38, size: 0.17, headroom: 0.15, edges: 0.12, level: levelWeightHigh ? 0.14 : 0.08, clutter: 0.05, symmetry: type === 'SYMMETRY' ? 0.12 : 0, horizon: horizon ? 0.08 : 0 };
    let total = 0, acc = 0;
    for (const k of Object.keys(w)) { if (w[k] > 0 && scores[k] != null) { total += w[k]; acc += w[k] * scores[k]; } }
    const framingScore = Math.round((acc / total) * 100);
    const targetBox = { x: idealX - (subjectBox.w * (targetH / subjectBox.h)) / 2, y: idealY - targetH / 2, w: subjectBox.w * (targetH / subjectBox.h), h: targetH };
    targetBox.w = Math.min(targetBox.w, 0.95); targetBox.x = clamp(targetBox.x, 0.02, 0.98 - targetBox.w); targetBox.y = clamp(targetBox.y, 0.02, 0.98 - targetBox.h);
    return { type, targetBox, idealCenter: { x: idealX, y: idealY }, deviation: { dx, dy }, sizeRatio, headroom, framingScore, issues, horizon, symmetry, clutter, scores, hasSubject: true, shot };
  }
}
