import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeParams, shadePixel, blurBackgroundWidth } from '../js/render/LookRenderer.js';
import { autoEnhance } from '../js/render/AutoEnhance.js';
import { HoldTrigger, handRaised, isSmiling } from '../js/capture/Triggers.js';
import { BurstSelector, sharpness } from '../js/capture/BurstSelector.js';
import { summarizeExpressions, minEyesOpen, expressionNear } from '../js/analysis/Expressions.js';
import { AutoCaptureController } from '../js/capture/AutoCaptureController.js';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { luminanceHistogram } from '../js/ui/Histogram.js';
import { makePose, makeImage } from './helpers.js';

test('editor adjustments stack on top of a look', () => {
  const base = composeParams('natural', 1);
  assert.equal(base.brightness, 1); assert.equal(base.saturation, 1);
  const p = composeParams('natural', 1, { light: 0.5, contrast: 0.5, warmth: 0.5, saturation: -1, vignette: 1 });
  assert.ok(p.brightness > 1.2 && p.contrast > 1.15 && p.temperature > 0.2 && p.vignette > 0.6);
  assert.ok(Math.abs(p.saturation - 0.3) < 1e-9);
  const grey = shadePixel(0.8, 0.5, 0.3, 0.5, 0.5, composeParams('vibrant', 1, { saturation: -1 }));
  assert.ok(Math.abs(grey[0] - grey[2]) < 0.35, 'saturation slider tames even vibrant');
  assert.equal(composeParams('bw', 0).saturation, 1, 'strength 0 is neutral');
  assert.ok(blurBackgroundWidth(1) < blurBackgroundWidth(0.5) && blurBackgroundWidth(0.5) < blurBackgroundWidth(0));
});

test('auto-enhance brightens dark, cool, flat photos and leaves good ones alone', () => {
  const dark = autoEnhance(makeImage(64, 64, (x, y) => [40 + 30 * x, 45 + 30 * y, 70]));
  assert.ok(dark.light > 0.3, JSON.stringify(dark));
  assert.ok(dark.contrast > 0.2, 'flat → more contrast');
  assert.ok(dark.warmth > 0.05, 'blue cast → warmer');
  const good = autoEnhance(makeImage(64, 64, (x, y) => [20 + 220 * x, 20 + 210 * y, 30 + 200 * (1 - x)]));
  assert.ok(Math.abs(good.light) < 0.2 && Math.abs(good.contrast) < 0.2, JSON.stringify(good));
});

test('raise-hand gesture is detected only for a clear raised arm', () => {
  const t = new SubjectTracker();
  const up = t.update({ people: [makePose({ armsUp: true })], faces: [], t: 0 }).primary;
  const down = new SubjectTracker().update({ people: [makePose({})], faces: [], t: 0 }).primary;
  assert.equal(handRaised(up), true);
  assert.equal(handRaised(down), false);
  assert.equal(handRaised({ ...up, coasting: true }), false);
});

test('hold trigger fires once after the hold time, then cools down', () => {
  const tr = new HoldTrigger({ holdMs: 500, cooldownMs: 3000 });
  let fired = 0;
  for (let t = 0; t <= 2000; t += 50) if (tr.update(true, t)) fired++;
  assert.equal(fired, 1);
  for (let t = 2050; t <= 4200; t += 50) if (tr.update(true, t)) fired++;   // cooldown ends 3500, +500 hold
  assert.equal(fired, 2, 'fires again after cooldown');
  const brief = new HoldTrigger({ holdMs: 500 });
  assert.equal([0, 100, 200].some((t) => brief.update(true, t)) || brief.update(false, 300) || brief.update(true, 400), false);
  assert.equal(isSmiling({ smile: 0.8 }), true); assert.equal(isSmiling({ smile: 0.2 }), false); assert.equal(isSmiling(null), false);
});

test('burst keeps the sharpest frame with eyes open', () => {
  const sharpImg = makeImage(40, 40, (x, y) => ((Math.floor(x * 20) + Math.floor(y * 20)) % 2 ? [255, 255, 255] : [0, 0, 0]));
  const blurImg = makeImage(40, 40, (x) => [128 + 20 * x, 128, 128]);
  assert.ok(sharpness(sharpImg) > sharpness(blurImg) * 100);
  const sel = new BurstSelector();
  sel.offer({ sharp: 50, eyesOpen: 1 }, () => 'soft');
  sel.offer({ sharp: 400, eyesOpen: 0.1 }, () => 'sharp-but-blinking');
  sel.offer({ sharp: 380, eyesOpen: 1 }, () => 'sharp-eyes-open');
  sel.offer({ sharp: 120, eyesOpen: 1 }, () => 'meh');
  assert.equal(sel.best.payload, 'sharp-eyes-open'); assert.equal(sel.frames, 4);
});

test('face expressions are summarised in view coordinates', () => {
  const lm = [{ x: 0.4, y: 0.3 }, { x: 0.6, y: 0.5 }];
  const ex = summarizeExpressions([{ landmarks: lm, blendshapes: { mouthSmileLeft: 0.8, mouthSmileRight: 0.6, eyeBlinkLeft: 0.9, eyeBlinkRight: 0.7 } }], { x: 0.25, y: 0, w: 0.5, h: 1 });
  assert.equal(ex.length, 1);
  assert.ok(Math.abs(ex[0].center.x - 0.5) < 1e-9 && Math.abs(ex[0].smile - 0.7) < 1e-9 && Math.abs(ex[0].eyesOpen - 0.2) < 1e-9);
  assert.equal(minEyesOpen([]), 1); assert.ok(Math.abs(minEyesOpen(ex) - 0.2) < 1e-9);
  assert.equal(expressionNear(ex, { x: 0.5, y: 0.4 }), ex[0]);
});

test('blink guard: closed eyes block arming and delay the shutter', () => {
  const ac = new AutoCaptureController(); ac.setEnabled(true);
  const s = new SubjectTracker().update({ people: [makePose({})], faces: [], t: 0 }).primary;
  const good = { overall: 85, pose: 85, framing: 70, stability: 90, lighting: 70 };
  for (let t = 0; t <= 1500; t += 50) ac.update({ scores: good, subject: s, group: null, now: t, eyesOpen: 0.1 });
  assert.equal(ac.state, 'MONITORING'); assert.ok(ac.blockers.includes('eyes'));
  let captured = false; ac.on('capture', () => { captured = true; });
  // Eyes open, reach the end of the countdown, then blink right at the shutter moment.
  let t = 1550;
  for (; t <= 3100 && ac.state !== 'COUNTDOWN'; t += 50) ac.update({ scores: good, subject: s, group: null, now: t, eyesOpen: 1 });
  for (let k = 0; k < 22; k++, t += 50) ac.update({ scores: good, subject: s, group: null, now: t, eyesOpen: 0.1 });   // past the 800 ms countdown
  assert.equal(captured, false, 'waits while eyes are closed');
  ac.update({ scores: good, subject: s, group: null, now: t, eyesOpen: 1 });
  assert.equal(captured, true, 'fires as soon as eyes open');
});

test('histogram counts luminance into bins', () => {
  const h = luminanceHistogram(makeImage(10, 10, (x) => (x < 0.5 ? [0, 0, 0] : [255, 255, 255])), 16);
  assert.equal(h[0], 50); assert.equal(h[15], 50);
});
