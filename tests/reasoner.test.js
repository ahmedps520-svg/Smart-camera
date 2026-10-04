import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhotographyReasoner } from '../js/reasoning/PhotographyReasoner.js';
import { CompositionEngine } from '../js/analysis/CompositionEngine.js';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { PoseScorer } from '../js/analysis/PoseScorer.js';
import { makePose, makeImage } from './helpers.js';

const flat = makeImage(64, 48, () => [120, 120, 120]);
const level = { rollDeg: 0, pitchDeg: 0, stability: 1, level: true, available: true };
const presets = [{ factor: 1, optical: true }, { factor: 2, optical: true }];
const light = { score: 85, code: 'LIGHT_GOOD', advice: 'Good light', tone: 'good', isNight: false, isDark: false };

function state(poseOpts, motion = level, scene = 'portrait') {
  const tracked = new SubjectTracker().update({ people: poseOpts ? [makePose(poseOpts)] : [], faces: [], t: 0 });
  const composition = new CompositionEngine().evaluate({ tracked, scene, motion, pixels: flat });
  const pose = new PoseScorer().score(tracked.primary);
  return { mode: 'smart', scene, tracked, composition, pose, lighting: light, motion, zoom: { current: 1, presets, advice: { action: 'NONE' } }, group: null, scores: { pose: pose.score, framing: composition.framingScore, lighting: 85, stability: 100, overall: 85 } };
}

test('reasoner outputs structured, validated recommendations', () => {
  const r = new PhotographyReasoner();
  const { raw } = r.update(state({ cx: 0.9, headY: 0.25, height: 0.6 }), 0);
  assert.ok(['MOVE_LEFT', 'MOVE_RIGHT', 'SUBJECT_EDGE'].includes(raw.recommendation), raw.recommendation);
  assert.ok(raw.confidence > 0 && raw.confidence <= 1);
  assert.equal(raw.captureReady, false);
  assert.equal(raw.composition, 'RULE_OF_THIRDS');
});

test('subject on the ideal third → PERFECT and captureReady', () => {
  const r = new PhotographyReasoner();
  let out;
  for (let t = 0; t < 1200; t += 50) out = r.update(state({ cx: 2 / 3, headY: 0.09, height: 0.8 }), t);
  assert.equal(out.raw.recommendation, 'PERFECT');
  assert.equal(out.raw.captureReady, true);
  assert.equal(out.stable.code, 'PERFECT');
});

test('tilted camera on a landscape → LEVEL_CAMERA', () => {
  const r = new PhotographyReasoner();
  const { raw } = r.update(state(null, { ...level, rollDeg: 5, level: false }, 'landscape'), 0);
  assert.equal(raw.recommendation, 'LEVEL_CAMERA');
});

test('no person in pose mode → LOOKING', () => {
  const r = new PhotographyReasoner();
  const s = state(null); s.mode = 'pose';
  assert.equal(r.update(s, 0).raw.recommendation, 'LOOKING');
});
