import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoseScorer } from '../js/analysis/PoseScorer.js';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { makePose } from './helpers.js';

const subj = (opts, velocity = 0) => { const t = new SubjectTracker(); const r = t.update({ people: [makePose(opts)], faces: [], t: 1 }); r.primary.velocity = velocity; return r.primary; };

test('frontal, still, fully visible pose scores high', () => {
  const s = new PoseScorer().score(subj({}));
  assert.ok(s.score >= 85, `score ${s.score} ${JSON.stringify(s.components)}`);
});

test('turned-away face and hand over face lower the score', () => {
  const base = new PoseScorer().score(subj({})).score;
  const turned = new PoseScorer().score(subj({ facing: 0.9 })).score;
  const hand = new PoseScorer().score(subj({ moveWristToFace: true })).score;
  assert.ok(turned < base - 8, `${turned} vs ${base}`);
  assert.ok(hand < base - 8, `${hand} vs ${base}`);
});

test('movement reduces stability component', () => {
  const still = new PoseScorer().score(subj({}, 0)).components.stability;
  const moving = new PoseScorer().score(subj({}, 0.08)).components.stability;
  assert.equal(still, 1); assert.equal(moving, 0);
});

test('no subject → zero', () => { assert.equal(new PoseScorer().score(null).score, 0); });

test('tracker keeps the primary subject identity and measures velocity', () => {
  const t = new SubjectTracker();
  t.update({ people: [makePose({ cx: 0.3 }), makePose({ cx: 0.7, height: 0.5 })], faces: [], t: 0 });
  const r2 = t.update({ people: [makePose({ cx: 0.31 }), makePose({ cx: 0.7, height: 0.5 })], faces: [], t: 33 });
  assert.equal(r2.count, 2);
  assert.ok(Math.abs(r2.primary.center.x - 0.31) < 0.05);
  assert.ok(r2.primary.velocity > 0 && r2.primary.velocity < 0.02);
  assert.ok(r2.groupBox.w > 0.4);
});
