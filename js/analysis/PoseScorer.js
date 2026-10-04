import { POSE_SCORING } from '../config/defaults.js';
import { LM } from './SubjectTracker.js';
import { clamp01, deg, dist, mid, toleranceScore, mean } from '../util/math.js';

const vis = (p, t = 0.45) => !!p && (p.visibility ?? 1) >= t;

/**
 * Continuously scores how photographically strong a subject's pose is.
 * Every component is weighted by POSE_SCORING.weights (overridable), so the
 * algorithm is configuration, not code.
 *
 * @returns {{score:number, components:Object, issues:string[]}} score 0..100
 */
export class PoseScorer {
  constructor(config = POSE_SCORING) { this.config = config; }

  score(subject) {
    const { weights: W, targets: T } = this.config;
    const c = {}; const issues = [];
    if (!subject) return { score: 0, components: c, issues: ['No subject'] };
    const l = subject.landmarks;
    if (!l) {
      // Face-only subject: can only judge face visibility and stability.
      c.faceVisible = subject.faceBox ? 1 : 0.3;
      c.stability = clamp01(1 - (subject.velocity - T.stillVelocity) / (T.movingVelocity - T.stillVelocity));
      const s = (c.faceVisible * W.faceVisible + c.stability * W.stability) / (W.faceVisible + W.stability);
      return { score: Math.round(s * 100), components: c, issues: ['Body not detected'] };
    }

    // Visibility of core joints.
    const core = [LM.nose, LM.lEye, LM.rEye, LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip];
    const extra = [LM.lElbow, LM.rElbow, LM.lWrist, LM.rWrist];
    c.visibility = clamp01(mean(core.map((i) => l[i].visibility ?? 1)) * 0.75 + mean(extra.map((i) => l[i].visibility ?? 1)) * 0.25);
    if (c.visibility < 0.6) issues.push('Body partly hidden');

    // Head tilt (eye line) and head turn (nose offset between ears).
    const eyeTilt = deg(Math.atan2(l[LM.rEye].y - l[LM.lEye].y, l[LM.rEye].x - l[LM.lEye].x));
    let tilt = Math.abs(eyeTilt); if (tilt > 90) tilt = 180 - tilt;   // eye line angle folded to 0..90
    const turn = Math.abs(subject.facing ?? 0);           // 0 frontal, ~0.5 three-quarter, >0.8 profile
    const faceRatio = subject.shoulderW > 1e-3 ? subject.earW / subject.shoulderW : 0;
    const frontal = clamp01((faceRatio - 0.1) / (T.minFaceWidthRatio - 0.1));
    const turnScore = 1 - clamp01((turn - 0.35) / 0.5);
    c.headAngle = clamp01(toleranceScore(tilt, T.maxHeadTiltDeg, 3) * 0.35 + turnScore * 0.45 + frontal * 0.2);
    if (tilt > T.maxHeadTiltDeg * 1.3) issues.push('Head tilted');
    if (turn > 0.7) issues.push('Face turned away');

    // Face visible: eyes + nose confident, and the face detector agrees when available.
    const faceLm = mean([LM.nose, LM.lEye, LM.rEye].map((i) => l[i].visibility ?? 1));
    const inHead = (p) => p.x > subject.headBox.x && p.x < subject.headBox.x + subject.headBox.w && p.y > subject.headBox.y && p.y < subject.chinY;
    const handOnFace = [LM.lWrist, LM.rWrist].some((i) => vis(l[i]) && inHead(l[i]));
    c.faceVisible = clamp01(faceLm * (subject.faceBox ? 1 : 0.8) * (1 - 0.5 * clamp01((turn - 0.5) / 0.4)) * (handOnFace ? 0.6 : 1));
    if (c.faceVisible < 0.5) issues.push('Face not visible');

    // Shoulders: level and open toward the camera.
    const shTilt = Math.abs(deg(Math.atan2(l[LM.rShoulder].y - l[LM.lShoulder].y, l[LM.rShoulder].x - l[LM.lShoulder].x)));
    const shLevel = toleranceScore(shTilt > 90 ? 180 - shTilt : shTilt, T.maxShoulderTiltDeg, 3);
    const hipW = dist(l[LM.lHip], l[LM.rHip]);
    const open = hipW > 1e-3 ? clamp01(subject.shoulderW / (hipW * 1.1)) : 0.8;
    c.shoulders = clamp01(shLevel * 0.6 + open * 0.4);

    // Arms: hands should not cover the face; wrists should be clearly in or clearly out of frame.
    let arms = 1;
    for (const i of [LM.lWrist, LM.rWrist]) {
      const w = l[i]; const v = w.visibility ?? 1;
      if (vis(w) && inHead(w)) arms -= 0.6;
      if (v > 0.2 && v < 0.5) arms -= 0.15;              // ambiguous / cut off at the frame edge
      if (vis(w) && (w.x < 0.01 || w.x > 0.99 || w.y > 0.99)) arms -= 0.2;
    }
    c.arms = clamp01(arms);
    if (c.arms < 0.6) issues.push('Hands covering face or cut off');

    // Legs: only judged on full-body shots.
    let legW = 0;
    if (subject.shotType === 'full') {
      legW = W.legs;
      const kneesOrdered = Math.sign(l[LM.lKnee].x - l[LM.rKnee].x) === Math.sign(l[LM.lHip].x - l[LM.rHip].x);
      const ankles = mean([l[LM.lAnkle].visibility ?? 1, l[LM.rAnkle].visibility ?? 1]);
      const feetIn = l[LM.lAnkle].y < 0.985 && l[LM.rAnkle].y < 0.985;
      c.legs = clamp01((kneesOrdered ? 0.5 : 0.2) + ankles * 0.3 + (feetIn ? 0.2 : 0));
      if (!feetIn) issues.push('Feet cut off');
    }

    // Symmetry: compare left/right torso lengths and elbow heights.
    const lt = dist(l[LM.lShoulder], l[LM.lHip]), rt = dist(l[LM.rShoulder], l[LM.rHip]);
    const torsoSym = 1 - Math.abs(lt - rt) / Math.max(1e-3, (lt + rt) / 2);
    const elbowSym = 1 - Math.abs(l[LM.lElbow].y - l[LM.rElbow].y) / Math.max(1e-3, subject.box.h);
    c.symmetry = clamp01(torsoSym * 0.6 + elbowSym * 0.4);

    // Stability from landmark velocity.
    c.stability = clamp01(1 - (subject.velocity - T.stillVelocity) / (T.movingVelocity - T.stillVelocity));
    if (c.stability < 0.4) issues.push('Moving');

    const parts = [
      ['visibility', W.visibility], ['headAngle', W.headAngle], ['faceVisible', W.faceVisible], ['shoulders', W.shoulders],
      ['arms', W.arms], ['legs', legW], ['symmetry', W.symmetry], ['stability', W.stability],
    ].filter(([k, w]) => w > 0 && c[k] != null);
    const total = parts.reduce((s, [, w]) => s + w, 0);
    const score = parts.reduce((s, [k, w]) => s + c[k] * w, 0) / total;
    return { score: Math.round(score * 100), components: c, issues };
  }
}
