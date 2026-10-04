import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZoomAdvisor } from '../js/analysis/ZoomAdvisor.js';
import { SceneClassifier } from '../js/analysis/SceneClassifier.js';
import { FilterRecommender } from '../js/analysis/FilterRecommender.js';
import { LightingAnalyzer } from '../js/analysis/LightingAnalyzer.js';
import { GroupAnalyzer } from '../js/analysis/GroupAnalyzer.js';
import { LensModel } from '../js/camera/LensModel.js';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { makePose, makeImage } from './helpers.js';

const presets = [{ factor: 0.5, optical: true }, { factor: 1, optical: true }, { factor: 2, optical: true }, { factor: 5, optical: true }];

test('zoom advisor recommends 2× for a small subject at 1× after the hysteresis window', () => {
  const z = new ZoomAdvisor();
  const comp = { hasSubject: true, sizeRatio: 0.5 };
  let r = z.recommend({ composition: comp, scene: 'portrait', presets, currentZoom: 1, now: 0 });
  assert.equal(r.action, 'NONE'); // not yet stable
  r = z.recommend({ composition: comp, scene: 'portrait', presets, currentZoom: 1, now: 700 });
  assert.equal(r.action, 'ZOOM'); assert.equal(r.zoom, 2); assert.ok(r.optical);
});

test('zoom advisor says MOVE CLOSER when beyond the longest lens', () => {
  const z = new ZoomAdvisor();
  const comp = { hasSubject: true, sizeRatio: 0.12 };
  z.recommend({ composition: comp, scene: 'portrait', presets, currentZoom: 5, now: 0 });
  const r = z.recommend({ composition: comp, scene: 'portrait', presets, currentZoom: 5, now: 800 });
  assert.equal(r.action, 'CLOSER');
});

test('zoom advisor is quiet when the subject size is within tolerance', () => {
  const z = new ZoomAdvisor();
  const r = z.recommend({ composition: { hasSubject: true, sizeRatio: 0.95 }, scene: 'portrait', presets, currentZoom: 1, now: 5000 });
  assert.equal(r.action, 'NONE');
});

test('lens model exposes presets only when supported', () => {
  const lm = new LensModel();
  lm.update({ devices: [{ kind: 'videoinput', label: 'Back Camera' }, { kind: 'videoinput', label: 'Back Ultra Wide Camera' }, { kind: 'videoinput', label: 'Back Telephoto Camera' }], facing: 'environment', capabilities: { zoom: { min: 1, max: 15, step: 0.1 } } });
  assert.deepEqual(lm.presets().map((p) => p.factor), [0.5, 1, 2, 3, 5]);
  assert.ok(lm.presets().find((p) => p.factor === 5).optical);
  const basic = new LensModel();
  basic.update({ devices: [{ kind: 'videoinput', label: 'Front Camera' }], facing: 'user', capabilities: {} });
  assert.deepEqual(basic.presets().map((p) => p.factor), [1, 2]);
  assert.equal(basic.presets()[1].optical, false);
});

test('scene classifier is sticky and maps labels to scenes', () => {
  const sc = new SceneClassifier({ switchAfter: 3 });
  const none = new SubjectTracker().update({ people: [], faces: [], t: 0 });
  const light = { isNight: false, isDark: false, warmth: 1, mean: 0.5 };
  let r;
  for (let i = 0; i < 6; i++) r = sc.update({ sceneLabels: [{ label: 'cheeseburger', score: 0.8 }], objects: [], tracked: none, lighting: light });
  assert.equal(r.scene, 'food');
  r = sc.update({ sceneLabels: [{ label: 'sports car', score: 0.9 }], objects: [], tracked: none, lighting: light });
  assert.equal(r.scene, 'food', 'one frame must not flip the scene');
  for (let i = 0; i < 8; i++) r = sc.update({ sceneLabels: [{ label: 'sports car', score: 0.9 }], objects: [{ label: 'car', score: 0.9, box: { x: 0.2, y: 0.3, w: 0.5, h: 0.4 } }], tracked: none, lighting: light });
  assert.equal(r.scene, 'vehicle');
  const one = new SubjectTracker().update({ people: [makePose({})], faces: [], t: 0 });
  const sc2 = new SceneClassifier({ switchAfter: 2 });
  for (let i = 0; i < 6; i++) r = sc2.update({ sceneLabels: [], objects: [], tracked: one, lighting: light });
  assert.equal(r.scene, 'portrait');
});

test('lighting analyzer flags dark, bright and backlit frames', () => {
  const la = new LightingAnalyzer();
  const dark = la.analyze(makeImage(64, 48, () => [20, 20, 25]));
  assert.equal(dark.code, 'TOO_DARK'); assert.ok(dark.score < 50);
  const bright = la.analyze(makeImage(64, 48, () => [252, 252, 250]));
  assert.equal(bright.code, 'TOO_BRIGHT');
  const backlit = la.analyze(makeImage(64, 48, (x, y) => (x > 0.35 && x < 0.65 && y > 0.2 ? [40, 35, 30] : [240, 240, 235])), { box: { x: 0.35, y: 0.2, w: 0.3, h: 0.8 } });
  assert.equal(backlit.code, 'BACKLIT');
  const good = la.analyze(makeImage(64, 48, (x, y) => [40 + 200 * x, 50 + 180 * y, 100]));
  assert.ok(['LIGHT_GOOD', 'LIGHT_GREAT'].includes(good.code)); assert.ok(good.score >= 80);
});

test('filter recommender follows scene and light', () => {
  const fr = new FilterRecommender();
  assert.equal(fr.recommend({ lighting: { isNight: true, isDark: true, warmth: 1, saturation: 0.3, mean: 0.1, contrast: 0.2 }, scene: 'night' }).id, 'night');
  assert.equal(fr.recommend({ lighting: { isNight: false, isDark: false, warmth: 1.5, saturation: 0.4, mean: 0.4, contrast: 0.2 }, scene: 'sunset' }).id, 'golden');
  assert.equal(fr.recommend({ lighting: { isNight: false, isDark: false, warmth: 1.0, saturation: 0.08, mean: 0.5, contrast: 0.25 }, scene: 'street' }).id, 'bw');
  assert.equal(fr.recommend({ lighting: null }).id, 'natural');
});

test('group analyzer detects a person cut at the edge', () => {
  const tracked = new SubjectTracker().update({ people: [makePose({ cx: 0.3 }), makePose({ cx: 0.97, height: 0.6 })], faces: [], t: 0 });
  const g = new GroupAnalyzer().analyze(tracked);
  assert.equal(g.everyoneInFrame, false);
  assert.ok(g.issues.some((i) => /right/i.test(i.text)));
  const ok = new GroupAnalyzer().analyze(new SubjectTracker().update({ people: [makePose({ cx: 0.35 }), makePose({ cx: 0.65 })], faces: [], t: 0 }));
  assert.equal(ok.everyoneInFrame, true); assert.equal(ok.issues[0].code, 'GROUP_OK');
});
