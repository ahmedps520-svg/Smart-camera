import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { CompositionEngine } from '../js/analysis/CompositionEngine.js';
import { PhotographyReasoner } from '../js/reasoning/PhotographyReasoner.js';
import { SMART_PHOTO } from '../js/config/defaults.js';
import { makePose, makeImage } from './helpers.js';

const flat = makeImage(32, 64, () => [120, 120, 120]);
const level = { rollDeg: 0, stability: 1, level: true, available: true };

test('tracker keeps the subject through short detection dropouts, then lets go', () => {
  const t = new SubjectTracker({ coastMs: 700 });
  t.update({ people: [makePose({ cx: 0.4 })], faces: [], t: 0 });
  const mid = t.update({ people: [], faces: [], t: 400 });
  assert.equal(mid.count, 1); assert.equal(mid.coasting, true); assert.ok(mid.primary.smoothBox);
  const back = t.update({ people: [makePose({ cx: 0.45 })], faces: [], t: 500 });
  assert.ok(!back.coasting); assert.equal(back.count, 1);
  assert.equal(t.update({ people: [], faces: [], t: 1000 }).coasting, true);   // 500 ms after last seen
  assert.equal(t.update({ people: [], faces: [], t: 1201 }).count, 0);        // > 700 ms: let go
});

test('objects become the subject when there is no person', () => {
  const tracked = new SubjectTracker().update({ people: [], faces: [], t: 0 });
  const c = new CompositionEngine().evaluate({ tracked, scene: 'pet', motion: level, pixels: flat, objects: [{ label: 'dog', score: 0.8, box: { x: 0.6, y: 0.4, w: 0.3, h: 0.25 } }] });
  assert.equal(c.hasSubject, true); assert.equal(c.subjectKind, 'dog');
  assert.deepEqual(c.subjectBox, { x: 0.6, y: 0.4, w: 0.3, h: 0.25 });
});

function state(cx, mode = 'smart', lighting = { score: 30, code: 'TOO_DARK', advice: 'Too dark', tone: 'warn', isNight: false, isDark: true }) {
  const tracked = new SubjectTracker().update({ people: [makePose({ cx, headY: 0.1, height: 0.8 })], faces: [], t: 0 });
  const composition = new CompositionEngine().evaluate({ tracked, scene: 'portrait', motion: level, pixels: flat });
  return { mode, scene: 'portrait', tracked, composition, pose: null, lighting, motion: level, zoom: { current: 1, presets: [{ factor: 1, optical: true }], advice: { action: 'NONE' } }, group: null, scores: { framing: composition.framingScore } };
}

test('Smart Photo keeps to framing: no lighting nags, says Perfect when framed', () => {
  const r = new PhotographyReasoner(undefined, { enter: SMART_PHOTO.enterRatio, exit: SMART_PHOTO.exitRatio, minHoldMs: SMART_PHOTO.minHoldMs, confirmMs: SMART_PHOTO.confirmMs });
  let out; for (let t = 0; t <= 1500; t += 50) out = r.update(state(2 / 3), t);
  assert.equal(out.raw.recommendation, 'PERFECT');
  const pose = new PhotographyReasoner();
  assert.equal(pose.update(state(2 / 3, 'pose'), 0).raw.recommendation, 'TOO_DARK');
});

test('Smart Photo ignores small offsets that Smart Pose would correct', () => {
  const calm = new PhotographyReasoner(undefined, { enter: SMART_PHOTO.enterRatio, exit: SMART_PHOTO.exitRatio });
  const strict = new PhotographyReasoner();
  const s = state(2 / 3 + 0.07);   // 7 % off the third: beyond 5 % tolerance, inside the 8.5 % dead zone
  assert.ok(['MOVE_LEFT', 'MOVE_RIGHT'].includes(strict.update(s, 0).raw.recommendation));
  assert.ok(!['MOVE_LEFT', 'MOVE_RIGHT'].includes(calm.update(s, 0).raw.recommendation));
});

test('instruction is frozen while the phone is moving', () => {
  const r = new PhotographyReasoner(undefined, { minHoldMs: 0, confirmMs: 100 });
  let t = 0, out;
  for (; t <= 400; t += 50) out = r.update(state(0.9), t);
  const first = out.stable?.code;
  assert.ok(first, 'an instruction is showing');
  for (; t <= 2000; t += 50) out = r.update(state(2 / 3), t, { freeze: true });
  assert.equal(out.stable?.code, first, 'unchanged while frozen');
  for (; t <= 2600; t += 50) out = r.update(state(2 / 3), t);
  assert.equal(out.stable?.code, 'PERFECT');
});
