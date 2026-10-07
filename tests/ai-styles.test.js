import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShotFinder, planShot } from '../js/ai/ShotFinder.js';
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

const plan = (style, candidates, current = 1) => planShot({ candidates, style, current, presets });
const zoomOf = (p) => p.targetZoom ?? p.zoomOutFirst;

test('Cinematic zooms in more than Standard; Daily less; Scenic goes wide', () => {
  const person = [{ key: 'person', label: 'person', kind: 'person', box: { x: 0.42, y: 0.35, w: 0.15, h: 0.3 }, score: 0.9 }];
  const std = zoomOf(plan(S.standard, person)), cine = zoomOf(plan(S.cinematic, person)), daily = zoomOf(plan(S.daily, person));
  assert.equal(std, 2);
  assert.ok(cine > std, `cinematic ${cine} > standard ${std}`);
  assert.ok(daily <= std);
  assert.equal(plan(S.scenic, person).zoomOutFirst, 0.5);
  const boat = [{ key: 'obj:boat', label: 'distant boat', kind: 'vehicle', box: { x: 0.47, y: 0.5, w: 0.06, h: 0.03 }, score: 0.7 }];
  assert.equal(zoomOf(plan(S.standard, boat)), 2);
  assert.equal(zoomOf(plan(S.cinematic, boat)), 5, 'cinematic pushes all the way in on a distant boat');
  assert.ok(zoomOf(plan(S.street, boat)) <= 2, 'street caps at 2×');
});

test('the box is the photo: its size matches the zoom and it keeps the subject', () => {
  const person = [{ key: 'person', label: 'person', kind: 'person', box: { x: 0.6, y: 0.35, w: 0.1, h: 0.25 }, score: 0.9 }];
  const p = plan(S.standard, person);
  assert.equal(p.targetZoom, 2);
  assert.ok(Math.abs(p.box.w - 1 / p.targetZoom) < 0.03, `box ${p.box.w} vs zoom ${p.targetZoom}`);
  const b = person[0].box;
  assert.ok(b.x >= p.box.x && b.x + b.w <= p.box.x + p.box.w && b.y >= p.box.y && b.y + b.h <= p.box.y + p.box.h, 'whole person inside the framing');
});

test('style weights decide the subject: Snapchat picks the person, Scenic the sunset', () => {
  const c = [
    { key: 'person', label: 'person', kind: 'person', box: { x: 0.1, y: 0.4, w: 0.12, h: 0.3 }, score: 0.55 },
    { key: 'light:sunset glow', label: 'sunset glow', kind: 'light', box: { x: 0.6, y: 0.3, w: 0.2, h: 0.12 }, score: 0.5 },
  ];
  assert.equal(plan(S.snapchat, c).label, 'person');
  assert.equal(plan(S.scenic, c, 0.5).label, 'sunset glow');
});

test('thirds styles put the subject on a third of the box; Snapchat puts the face high', () => {
  const car = [{ key: 'obj:car', label: 'car', kind: 'vehicle', box: { x: 0.6, y: 0.45, w: 0.12, h: 0.06 }, score: 0.8 }];
  const p = plan(S.street, car);
  const relX = (0.66 - p.box.x) / p.box.w;
  assert.ok(Math.abs(relX - 2 / 3) < 0.05, `car at ${relX.toFixed(2)} of the box`);
  const face = [{ key: 'person', label: 'person', kind: 'person', box: { x: 0.3, y: 0.3, w: 0.4, h: 0.6 }, head: { x: 0.5, y: 0.4 }, score: 0.9 }];
  const q = plan(S.snapchat, face);
  assert.ok(Math.abs((0.4 - q.box.y) / q.box.h - 0.36) < 0.05);
});

test('Cinema frame keeps a 2.39:1 band around the subject', () => {
  const b = cinemaBand(3024, 4032, 0.3);
  assert.equal(b.h, Math.round(3024 / 2.39));
  assert.ok(Math.abs(b.y + b.h / 2 - 0.3 * 4032) < 2);
  assert.equal(cinemaBand(3024, 4032, 0.98).y, 4032 - b.h, 'clamped to the photo');
});
