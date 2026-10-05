import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollFromGravity } from '../js/motion/MotionSensor.js';
import { transformAnalysis } from '../js/vision/ViewTransform.js';
import { shadePixel, lookParams, composeParams } from '../js/render/LookRenderer.js';
import { CameraController } from '../js/camera/CameraController.js';
import { PoseScorer } from '../js/analysis/PoseScorer.js';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { CompositionEngine } from '../js/analysis/CompositionEngine.js';
import { ZoomAdvisor } from '../js/analysis/ZoomAdvisor.js';
import { makePose, makeImage } from './helpers.js';

test('level: upright phone reads 0° on both Android and iOS sign conventions', () => {
  assert.ok(Math.abs(rollFromGravity(0, 9.81, 0).rollDeg) < 1e-9);       // spec / Android
  assert.ok(Math.abs(rollFromGravity(-0, -9.81, -0).rollDeg) < 1e-9);    // iOS Safari (inverted)
  const tilt = (deg, sign) => { const r = deg * Math.PI / 180; return rollFromGravity(sign * -Math.sin(r) * 9.81, sign * Math.cos(r) * 9.81, 0).rollDeg; };
  assert.ok(Math.abs(tilt(5, 1) - -5) < 1e-6);
  assert.ok(Math.abs(tilt(5, -1) - -5) < 1e-6, 'iOS gives the same angle as Android');
  assert.ok(Math.abs(tilt(-3, -1) - 3) < 1e-6);
});

test('level: landscape orientations and flat phone', () => {
  assert.ok(Math.abs(rollFromGravity(9.81, 0, 0, 90).rollDeg) < 1e-9);
  assert.ok(Math.abs(rollFromGravity(-9.81, 0, 0, 90).rollDeg) < 1e-9);   // iOS sign
  assert.ok(Math.abs(rollFromGravity(-9.81, 0, 0, 270).rollDeg) < 1e-9);
  assert.equal(rollFromGravity(0.3, 0.4, 9.8).flat, true);
  assert.equal(rollFromGravity(0, 9.8, 1).flat, false);
});

test('view crop: cover + digital zoom', () => {
  const c = CameraController.cropFor(1920, 1080, 390, 844, 1);   // landscape stream into a tall phone view
  assert.equal(c.h, 1); assert.ok(Math.abs(c.w - (390 / 844) / (1920 / 1080)) < 1e-9); assert.ok(Math.abs(c.x - (1 - c.w) / 2) < 1e-9);
  const z = CameraController.cropFor(1080, 1920, 1080, 1920, 2);
  assert.deepEqual(z, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
});

test('view transform maps detections and hides landmarks outside the view', () => {
  const crop = { x: 0.25, y: 0, w: 0.5, h: 1 };
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  lm[15] = { x: 0.1, y: 0.5, visibility: 0.9 };   // outside the visible strip
  const out = transformAnalysis({ people: [{ landmarks: lm }], faces: [{ box: { x: 0.45, y: 0.2, w: 0.1, h: 0.1 }, keypoints: [] }, { box: { x: 0.0, y: 0.2, w: 0.05, h: 0.1 } }], objects: [] }, crop);
  assert.equal(out.people[0].landmarks[0].x, 0.5);
  assert.ok(out.people[0].landmarks[15].visibility <= 0.15);
  assert.equal(out.faces.length, 1);
  assert.ok(Math.abs(out.faces[0].box.x - 0.4) < 1e-9 && Math.abs(out.faces[0].box.w - 0.2) < 1e-9);
});

test('looks are strong and distinct', () => {
  const skin = [0.8, 0.6, 0.5];
  const out = (id, s = 1) => shadePixel(...skin, 0.5, 0.5, composeParams(id, s));
  const nat = out('natural');
  assert.deepEqual(nat.map((v) => +v.toFixed(6)), skin);
  const bw = out('bw'); assert.ok(Math.abs(bw[0] - bw[1]) < 1e-6 && Math.abs(bw[1] - bw[2]) < 1e-6, 'B&W is grey');
  const warm = out('warm'), cool = out('cool');
  assert.ok(warm[0] / warm[2] > (skin[0] / skin[2]) * 1.25, 'warm shifts noticeably toward red');
  assert.ok(cool[2] / cool[0] > (skin[2] / skin[0]) * 1.3, 'cool shifts noticeably toward blue');
  const vib = out('vibrant'); assert.ok(vib[0] - vib[2] > (skin[0] - skin[2]) * 1.5, 'vibrant boosts saturation');
  const half = out('warm', 0.5); assert.ok(half[0] > skin[0] && half[0] < warm[0], 'strength blends');
  const corner = shadePixel(...skin, 0, 0, lookParams('cinematic')), centre = out('cinematic');
  assert.ok(corner[1] < centre[1] * 0.75, 'cinematic vignette darkens corners');
});

test('selfie (head and shoulders) pose scores well without hips or arms', () => {
  const p = makePose({ cx: 0.5, headY: 0.15, height: 1.6 });
  for (const i of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 15, 16, 17, 18, 19, 20, 21, 22, 13, 14]) p.landmarks[i].visibility = 0.05;
  const s = new SubjectTracker().update({ people: [p], faces: [], t: 1 }).primary;
  s.velocity = 0;
  assert.equal(s.shotType, 'closeUp');
  const r = new PoseScorer().score(s);
  assert.ok(r.score >= 80, `selfie pose ${r.score} ${JSON.stringify(r.components)}`);
});

test('selfie composition is centred; front camera gets distance advice not zoom', () => {
  const tracked = new SubjectTracker().update({ people: [makePose({ cx: 0.5, headY: 0.12, height: 0.8 })], faces: [], t: 0 });
  const flat = makeImage(32, 64, () => [120, 120, 120]);
  const c = new CompositionEngine().evaluate({ tracked, scene: 'portrait', motion: { rollDeg: 0, stability: 1, level: true, available: true }, pixels: flat, selfie: true });
  assert.equal(c.idealCenter.x, 0.5);
  assert.ok(!c.issues.some((i) => i.code === 'MOVE_LEFT' || i.code === 'MOVE_RIGHT'));
  const z = new ZoomAdvisor();
  const presets = [{ factor: 1, optical: true }, { factor: 2, optical: false }];
  z.recommend({ composition: { hasSubject: true, sizeRatio: 0.4 }, presets, currentZoom: 1, now: 0, allowZoom: false });
  const r = z.recommend({ composition: { hasSubject: true, sizeRatio: 0.4 }, presets, currentZoom: 1, now: 700, allowZoom: false });
  assert.equal(r.action, 'CLOSER'); assert.equal(r.zoom, null);
});
