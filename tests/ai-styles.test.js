import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShotFinder } from '../js/ai/ShotFinder.js';
import { AI_STYLES, FILTERS } from '../js/config/defaults.js';
import { cinemaBand, FRAMES } from '../js/render/Frames.js';

const S = Object.fromEntries(AI_STYLES.map((s) => [s.id, s]));
const presets = [{ factor: 0.5 }, { factor: 1 }, { factor: 2 }, { factor: 5 }];

test('every style is complete and points at real looks and frames', () => {
  assert.deepEqual(AI_STYLES.map((s) => s.id), ['standard', 'daily', 'cinematic', 'snapchat', 'scenic', 'street', 'film']);
  for (const s of AI_STYLES) {
    assert.ok(s.name && s.scanText && s.scanMs > 0 && s.readyHoldMs > 0, s.id);
    if (s.look) assert.ok(FILTERS.some((f) => f.id === s.look), `${s.id} look ${s.look}`);
    if (s.frame) assert.ok(FRAMES.some((f) => f.id === s.frame), `${s.id} frame ${s.frame}`);
  }
});

test('Cinematic zooms in more than Standard; Daily less; Scenic goes wide', () => {
  const person = { kind: 'person', box: { w: 0.15, h: 0.3 } };
  const std = ShotFinder.chooseZoom(person, 1, presets, S.standard);
  const cine = ShotFinder.chooseZoom(person, 1, presets, S.cinematic);
  const daily = ShotFinder.chooseZoom(person, 1, presets, S.daily);
  assert.equal(std, 2);
  assert.ok(cine > std, `cinematic ${cine} > standard ${std}`);
  assert.ok(Math.abs(cine * 10 - Math.round(cine * 10)) < 1e-9, 'continuous zoom in 0.1 steps');
  assert.ok(daily <= std);
  assert.equal(ShotFinder.chooseZoom({ kind: 'light', box: { w: 0.2, h: 0.1 } }, 1, presets, S.scenic), 0.5);
  const boat = { kind: 'vehicle', box: { w: 0.06, h: 0.03 } };
  assert.equal(ShotFinder.chooseZoom(boat, 1, presets, S.standard), 2);
  assert.equal(ShotFinder.chooseZoom(boat, 1, presets, S.cinematic), 5, 'cinematic pushes all the way in on a distant boat');
  assert.ok(ShotFinder.chooseZoom(boat, 1, presets, S.street) <= 2, 'street caps at 2×');
});

function scan(style, candidates, until) {
  const f = new ShotFinder(); f.start(0, style);
  let picked = null; f.on('acquire', (e) => { picked = e.label; });
  for (let t = 0; t <= until; t += 100) f.update({ candidates }, t);
  return { f, picked };
}

test('Daily and Snapchat scan faster than Standard', () => {
  const c = [{ key: 'person', label: 'person', kind: 'person', box: { x: 0.4, y: 0.3, w: 0.2, h: 0.5 }, score: 0.9 }];
  assert.equal(scan(S.standard, c, 1600).picked, null);
  assert.equal(scan(S.daily, c, 1600).picked, 'person');
  assert.equal(scan(S.snapchat, c, 1300).picked, 'person');
});

test('style weights decide the subject: Snapchat picks the person, Scenic the sunset', () => {
  const c = [
    { key: 'person', label: 'person', kind: 'person', box: { x: 0.1, y: 0.4, w: 0.12, h: 0.3 }, score: 0.55 },
    { key: 'light:sunset glow', label: 'sunset glow', kind: 'light', box: { x: 0.6, y: 0.3, w: 0.2, h: 0.12 }, score: 0.5 },
  ];
  assert.equal(scan(S.snapchat, c, 1300).picked, 'person');
  assert.equal(scan(S.scenic, c, 3100).picked, 'sunset glow');
});

test('Cinematic aims at a third and never flips sides', () => {
  const c = [{ key: 'obj:car', label: 'car', kind: 'vehicle', box: { x: 0.6, y: 0.45, w: 0.2, h: 0.1 }, score: 0.8 }];
  const { f } = scan(S.cinematic, c, 3300);
  const vm = f.update({ track: { box: { x: 0.57, y: 0.45, w: 0.2, h: 0.1 } }, zoom: { current: 1, presets } }, 3400);
  assert.ok(Math.abs(vm.aim.x - 2 / 3) < 1e-9);
  const vm2 = f.update({ track: { box: { x: 0.3, y: 0.45, w: 0.2, h: 0.1 } }, zoom: { current: 1, presets } }, 3500);
  assert.ok(Math.abs(vm2.aim.x - 2 / 3) < 1e-9, 'third stays fixed after acquisition');
  assert.equal(vm2.message, 'Move your phone left');
});

test('Scenic waits for a level horizon before shooting', () => {
  const c = [{ key: 'light:sunset glow', label: 'sunset glow', kind: 'light', box: { x: 0.4, y: 0.36, w: 0.2, h: 0.12 }, score: 0.6 }];
  const { f } = scan(S.scenic, c, 3100);
  let captured = false; f.on('capture', () => { captured = true; });
  const at = { track: { box: c[0].box }, zoom: { current: 0.5, presets } };
  let vm;
  for (let t = 3200; t <= 6000; t += 100) vm = f.update({ ...at, motion: { available: true, stability: 1, rollDeg: 6 } }, t);
  assert.equal(captured, false); assert.equal(vm.message, 'Level your phone');
  for (let t = 6100; t <= 8000 && !captured; t += 100) f.update({ ...at, motion: { available: true, stability: 1, rollDeg: 0.5 } }, t);
  assert.equal(captured, true);
});

test('Cinema frame keeps a 2.39:1 band around the subject', () => {
  const b = cinemaBand(3024, 4032, 0.3);
  assert.equal(b.h, Math.round(3024 / 2.39));
  assert.ok(Math.abs(b.y + b.h / 2 - 0.3 * 4032) < 2);
  assert.equal(cinemaBand(3024, 4032, 0.98).y, 4032 - b.h, 'clamped to the photo');
});

test('Snapchat steers by the face, not the middle of the body', () => {
  const body = { x: 0.1, y: 0.36, w: 0.8, h: 0.52 };
  const c = [{ key: 'person', label: 'person', kind: 'person', box: body, head: { x: 0.5, y: 0.42 }, score: 0.9 }];
  const { f } = scan(S.snapchat, c, 1300);
  const vm = f.update({ track: { box: body, head: { x: 0.5, y: 0.4 } }, zoom: { current: 1, presets } }, 1400);
  assert.equal(vm.aim.y, 0.36);
  assert.equal(vm.message, 'Centered — framing up...', 'face is near the aim point even though the body is low');
  const std = scan(S.standard, c, 3100).f.update({ track: { box: body } }, 3200);
  assert.ok(Math.abs(std.aim.y - 0.55) < 1e-9);
});

test('before a big zoom, centring is tighter so the subject stays framed after zooming', () => {
  const box = (x) => ({ x, y: 0.47, w: 0.06, h: 0.03 });
  const run = (style, x) => { const { f } = scan(style, [{ key: 'obj:boat', label: 'distant boat', kind: 'vehicle', box: box(x), score: 0.7 }], 3300); return f.update({ track: { box: box(x) }, zoom: { current: 1, presets } }, 3400).message; };
  // 0.035 off-centre: fine before Standard's 2× zoom, too far before Cinematic's 5× push.
  assert.equal(run(S.standard, 0.435), 'Centered — framing up...');
  assert.match(run({ ...S.cinematic, aim: 'center' }, 0.435), /Move your phone left/);
});

test('Snapchat accepts the face anywhere in the upper band', () => {
  const body = { x: 0.03, y: 0.03, w: 0.92, h: 0.86 };
  const c = [{ key: 'person', label: 'person', kind: 'person', box: body, head: { x: 0.5, y: 0.24 }, score: 0.9 }];
  const { f } = scan(S.snapchat, c, 1300);
  assert.equal(f.update({ track: { box: body, head: { x: 0.5, y: 0.24 } }, zoom: { current: 1, presets } }, 1400).message, 'Centered — framing up...');
  const g = scan(S.snapchat, c, 1300).f;
  assert.equal(g.update({ track: { box: body, head: { x: 0.5, y: 0.08 } }, zoom: { current: 1, presets } }, 1400).message, 'Move your phone up');
});

test('Cinematic keeps faces in the middle of the widescreen band', () => {
  const body = { x: 0.3, y: 0.3, w: 0.4, h: 0.6 };
  const c = [{ key: 'person', label: 'person', kind: 'person', box: body, head: { x: 0.5, y: 0.36 }, score: 0.9 }];
  const ask = (headY) => { const { f } = scan(S.cinematic, c, 3300); return f.update({ track: { box: body, head: { x: 0.5, y: headY } }, zoom: { current: 1, presets } }, 3400); };
  assert.equal(ask(0.36).message, 'Move your phone up', 'face too high for the 2.39:1 strip');
  assert.equal(ask(0.49).aim.y, 0.49);
});
