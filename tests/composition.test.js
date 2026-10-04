import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompositionEngine } from '../js/analysis/CompositionEngine.js';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { makePose, makeImage } from './helpers.js';

const track = (poses, t = 1000) => { const tr = new SubjectTracker(); return tr.update({ people: poses, faces: [], t }); };
const flat = makeImage(64, 48, () => [120, 120, 120]);
const level = { rollDeg: 0, pitchDeg: 0, stability: 1, level: true, available: true };

test('portrait → rule of thirds, subject right of ideal reports MOVE_RIGHT', () => {
  const engine = new CompositionEngine();
  const tracked = track([makePose({ cx: 0.85, headY: 0.25, height: 0.6 })]);
  const c = engine.evaluate({ tracked, scene: 'portrait', motion: level, pixels: flat });
  assert.equal(c.type, 'RULE_OF_THIRDS');
  assert.ok(c.hasSubject);
  assert.ok(c.idealCenter.x < 0.85);
  assert.ok(c.issues.some((i) => i.code === 'MOVE_RIGHT' || i.code === 'EDGE_RIGHT'));
  assert.ok(c.framingScore < 80);
});

test('subject on the third with headroom scores high', () => {
  const engine = new CompositionEngine();
  const tracked = track([makePose({ cx: 2 / 3, headY: 0.09, height: 0.8 })]);
  const c = engine.evaluate({ tracked, scene: 'portrait', motion: level, pixels: flat });
  assert.ok(c.framingScore >= 80, `framing ${c.framingScore}`);
  assert.ok(!c.issues.some((i) => i.severity >= 2), JSON.stringify(c.issues));
});

test('lead room: subject looking image-left is placed on the right third', () => {
  const engine = new CompositionEngine();
  const tracked = track([makePose({ cx: 0.5, headY: 0.2, height: 0.6, facing: -0.6 })]);
  const c = engine.evaluate({ tracked, scene: 'portrait', motion: level, pixels: flat });
  assert.ok(Math.abs(c.idealCenter.x - 2 / 3) < 0.05);
});

test('group → GROUP composition centred', () => {
  const engine = new CompositionEngine();
  const tracked = track([makePose({ cx: 0.3, headY: 0.2, height: 0.6 }), makePose({ cx: 0.7, headY: 0.22, height: 0.6 })]);
  const c = engine.evaluate({ tracked, scene: 'group', motion: level, pixels: flat });
  assert.equal(c.type, 'GROUP');
  assert.ok(Math.abs(c.idealCenter.x - 0.5) < 0.01);
});

test('tilted camera lowers framing and raises LEVEL for landscapes', () => {
  const engine = new CompositionEngine();
  const tracked = track([]);
  const sky = makeImage(64, 48, (x, y) => (y < 0.5 ? [180, 200, 240] : [60, 90, 40]));
  const tilted = engine.evaluate({ tracked, scene: 'landscape', motion: { ...level, rollDeg: 6, level: false }, pixels: sky });
  const straight = engine.evaluate({ tracked, scene: 'landscape', motion: level, pixels: sky });
  assert.equal(tilted.type, 'HORIZON');
  assert.ok(tilted.issues.some((i) => i.code === 'LEVEL'));
  assert.ok(straight.framingScore > tilted.framingScore);
  assert.ok(straight.horizon && Math.abs(straight.horizon.y - 0.5) < 0.08);
});

test('architecture → symmetry score from mirrored image', () => {
  const sym = makeImage(64, 48, (x) => (Math.abs(x - 0.5) < 0.2 ? [200, 200, 200] : [40, 40, 40]));
  const asym = makeImage(64, 48, (x) => (x < 0.3 ? [200, 200, 200] : [40, 40, 40]));
  assert.ok(CompositionEngine.symmetry(sym) > 0.95);
  assert.ok(CompositionEngine.symmetry(asym) < 0.7);
});

test('subject spilling out of frame → MOVE BACK', () => {
  const engine = new CompositionEngine();
  const tracked = track([makePose({ cx: 0.5, headY: -0.05, height: 1.1 })]);
  const c = engine.evaluate({ tracked, scene: 'portrait', motion: level, pixels: flat });
  assert.ok(c.issues.some((i) => i.code === 'TOO_BIG' || i.code === 'MORE_HEADROOM'), JSON.stringify(c.issues));
});
