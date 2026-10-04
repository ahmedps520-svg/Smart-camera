import { GUIDANCE } from '../config/defaults.js';
import { EMAVector } from '../util/smoothing.js';
import { clamp01, dist, mid, unionBox, boxCenter } from '../util/math.js';

/** MediaPipe pose landmark indices. */
export const LM = {
  nose: 0, lEyeIn: 1, lEye: 2, lEyeOut: 3, rEyeIn: 4, rEye: 5, rEyeOut: 6, lEar: 7, rEar: 8, mouthL: 9, mouthR: 10,
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16, lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20,
  lThumb: 21, rThumb: 22, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28, lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
};
const VIS = 0.45;
const vis = (p, t = VIS) => !!p && (p.visibility ?? 1) >= t;

/**
 * Turns raw pose/face detections into tracked, smoothed subjects.
 * Keeps identity of the primary subject across frames (nearest centre), computes
 * head position, estimated head top, shot type, landmark velocity and a group box.
 */
export class SubjectTracker {
  constructor() {
    this.prevPrimary = null;
    this.prevLandmarks = null;
    this.prevT = 0;
    this.smooth = new EMAVector(GUIDANCE.smoothing);
    this.velocity = 0;
    this.nextId = 1;
    this.tracks = []; // [{id, center}]
  }

  reset() { this.prevPrimary = null; this.prevLandmarks = null; this.smooth.reset(); this.velocity = 0; this.tracks = []; }

  static describe(person) {
    const l = person.landmarks;
    const pts = l.filter((p) => vis(p, 0.3)).map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
    if (pts.length < 4) return null;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    let box = { x: Math.min(...xs), y: Math.min(...ys), w: 0, h: 0 };
    box.w = Math.max(...xs) - box.x; box.h = Math.max(...ys) - box.y;

    const eyeC = mid(l[LM.lEye], l[LM.rEye]);
    const mouthC = mid(l[LM.mouthL], l[LM.mouthR]);
    const faceH = Math.max(0.01, dist(eyeC, mouthC));
    const headTopY = clamp01(eyeC.y - faceH * 1.9);     // top of skull ≈ eyes − ~1.9× eye-to-mouth
    const chinY = mouthC.y + faceH * 0.9;
    const head = { x: l[LM.nose].x, y: (headTopY + chinY) / 2 };
    const headBox = { x: Math.min(l[LM.lEar].x, l[LM.rEar].x, eyeC.x - faceH), y: headTopY, w: 0, h: chinY - headTopY };
    headBox.w = Math.max(l[LM.lEar].x, l[LM.rEar].x, eyeC.x + faceH) - headBox.x;
    box = { ...box, y: Math.min(box.y, headTopY), h: Math.max(box.y + box.h, chinY) - Math.min(box.y, headTopY) };

    const feet = vis(l[LM.lAnkle]) || vis(l[LM.rAnkle]);
    const knees = vis(l[LM.lKnee]) || vis(l[LM.rKnee]);
    const hips = vis(l[LM.lHip]) || vis(l[LM.rHip]);
    const shotType = feet ? 'full' : knees ? 'threeQuarter' : hips ? 'half' : 'closeUp';
    const shoulderW = dist(l[LM.lShoulder], l[LM.rShoulder]);
    const earW = dist(l[LM.lEar], l[LM.rEar]);
    const earMid = mid(l[LM.lEar], l[LM.rEar]);
    // Facing: 0 = frontal, negative = looking toward image-left, positive = image-right.
    const facing = earW > 1e-3 ? (l[LM.nose].x - earMid.x) / earW : 0;
    return { landmarks: l, world: person.world, box, center: boxCenter(box), head, headBox, headTopY, chinY, faceH, shotType, shoulderW, earW, facing };
  }

  /** @returns {{count:number, subjects:any[], primary:any|null, groupBox:any|null, faceCount:number}} */
  update({ people, faces, t }) {
    const subjects = people.map(SubjectTracker.describe).filter(Boolean);
    // Attach face detections to subjects (overlap with head box), keep leftover faces as face-only subjects.
    const leftover = [];
    for (const f of faces) {
      const c = boxCenter(f.box);
      const s = subjects.find((s) => c.x >= s.headBox.x - 0.03 && c.x <= s.headBox.x + s.headBox.w + 0.03 && c.y >= s.headBox.y - 0.03 && c.y <= s.chinY + 0.03);
      if (s) s.faceBox = f.box; else leftover.push(f);
    }
    for (const f of leftover) {
      // A face without a detected body (e.g. head-only in a crowd): synthesise a subject from the face box.
      const b = f.box; const h = b.h * 4.5;
      const box = { x: clamp01(b.x - b.w * 0.6), y: clamp01(b.y - b.h * 0.3), w: Math.min(1, b.w * 2.2), h: Math.min(1 - b.y, h) };
      subjects.push({ landmarks: null, box, center: boxCenter(box), head: boxCenter(b), headBox: b, headTopY: b.y - b.h * 0.3, chinY: b.y + b.h, faceH: b.h * 0.5, shotType: 'closeUp', faceBox: b, facing: 0, faceOnly: true });
    }
    // Identity: assign ids by nearest previous track.
    const used = new Set();
    for (const s of subjects) {
      let best = null, bd = 0.2;
      for (const tr of this.tracks) { if (used.has(tr.id)) continue; const d = dist(tr.center, s.center); if (d < bd) { bd = d; best = tr; } }
      s.id = best ? best.id : this.nextId++;
      used.add(s.id);
    }
    this.tracks = subjects.map((s) => ({ id: s.id, center: s.center }));

    let primary = null;
    if (subjects.length) {
      // Prefer the previous primary if still present, otherwise the largest.
      primary = (this.prevPrimary && subjects.find((s) => s.id === this.prevPrimary.id)) || subjects.reduce((a, b) => (b.box.w * b.box.h > a.box.w * a.box.h ? b : a));
      if (this.prevPrimary && primary.id === this.prevPrimary.id && primary.box.w * primary.box.h < 0.5 * Math.max(...subjects.map((s) => s.box.w * s.box.h))) {
        primary = subjects.reduce((a, b) => (b.box.w * b.box.h > a.box.w * a.box.h ? b : a));
      }
      // Velocity: mean normalised displacement of core landmarks per 33 ms.
      const dt = Math.max(8, t - this.prevT);
      if (primary.landmarks && this.prevLandmarks && this.prevPrimary?.id === primary.id) {
        const idx = [LM.nose, LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip, LM.lWrist, LM.rWrist];
        let sum = 0, n = 0;
        for (const i of idx) { const a = primary.landmarks[i], b = this.prevLandmarks[i]; if (vis(a, 0.3) && vis(b, 0.3)) { sum += dist(a, b); n++; } }
        const v = n ? (sum / n) * (33 / dt) : 0;
        this.velocity = this.velocity + 0.4 * (v - this.velocity);
      } else if (!primary.landmarks) {
        const v = this.prevPrimary ? dist(primary.center, this.prevPrimary.center) * (33 / dt) : 0;
        this.velocity = this.velocity + 0.4 * (v - this.velocity);
      }
      primary.velocity = this.velocity;
      primary.smoothBox = { ...this.smooth.push(primary.box) };
      primary.smoothCenter = boxCenter(primary.smoothBox);
      this.prevLandmarks = primary.landmarks;
      this.prevPrimary = primary;
      this.prevT = t;
    } else {
      this.prevPrimary = null; this.prevLandmarks = null; this.smooth.reset(); this.velocity = 0;
    }
    const groupBox = subjects.length > 1 ? unionBox(subjects.map((s) => s.box)) : null;
    return { count: subjects.length, subjects, primary, groupBox, faceCount: faces.length };
  }
}
