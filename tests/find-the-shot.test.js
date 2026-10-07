import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectCandidates, saliencyCandidate, describe, peopleCandidates } from '../js/ai/Candidates.js';
import { TemplateTracker, toGray } from '../js/ai/TemplateTracker.js';
import { ShotFinder } from '../js/ai/ShotFinder.js';
import { focalLength, specsLine, dateStamp, FRAMES } from '../js/render/Frames.js';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { makePose, makeImage } from './helpers.js';

test('candidates get human labels and sensible scores', () => {
  assert.equal(describe('boat', { w: 0.05, h: 0.03 }), 'distant boat');
  assert.equal(describe('dog', { w: 0.3, h: 0.3 }), 'dog');
  assert.equal(describe('cup', { w: 0.7, h: 0.6 }), 'cup up close');
  const c = objectCandidates([{ label: 'boat', score: 0.7, box: { x: 0.4, y: 0.5, w: 0.06, h: 0.03 } }, { label: 'chair', score: 0.2, box: { x: 0, y: 0, w: 0.2, h: 0.2 } }]);
  assert.equal(c.length, 1); assert.equal(c[0].label, 'distant boat'); assert.equal(c[0].kind, 'vehicle');
  const people = peopleCandidates(new SubjectTracker().update({ people: [makePose({})], faces: [], t: 0 }), { selfie: true });
  assert.equal(people[0].label, 'you');
});

test('saliency finds the sunset glow', () => {
  const sunset = makeImage(64, 96, (x, y) => {
    const d = Math.hypot(x - 0.7, y - 0.45);
    return d < 0.08 ? [255, 170, 70] : y < 0.5 ? [60, 70, 110] : [30, 35, 50];
  });
  const s = saliencyCandidate(sunset, { scene: 'outdoor' });
  assert.ok(s); assert.equal(s.label, 'sunset glow');
  const cx = s.box.x + s.box.w / 2, cy = s.box.y + s.box.h / 2;
  assert.ok(Math.abs(cx - 0.7) < 0.12 && Math.abs(cy - 0.45) < 0.1, JSON.stringify(s.box));
  assert.equal(saliencyCandidate(makeImage(32, 48, () => [120, 120, 120])), null, 'flat frames have no subject');
  // A glow straddling two grid cells is located between them, not snapped to one.
  const mid = makeImage(64, 96, (x, y) => (Math.hypot(x - 0.5, y - 0.5) < 0.09 ? [255, 175, 80] : [50, 60, 95]));
  const m = saliencyCandidate(mid);
  assert.ok(Math.abs(m.box.x + m.box.w / 2 - 0.5) < 0.03 && Math.abs(m.box.y + m.box.h / 2 - 0.5) < 0.03, JSON.stringify(m.box));
});

test('template tracker follows a subject as the phone moves', () => {
  const frame = (ox, oy) => makeImage(120, 160, (x, y) => {
    const px = x * 120 - ox, py = y * 160 - oy;
    const boat = px > 50 && px < 62 && py > 80 && py < 86;
    const mast = px > 55 && px < 57 && py > 70 && py < 80;
    return boat || mast ? [20, 20, 25] : [200 - y * 80, 140 - y * 60, 120 + ((x * 120) % 7)];
  });
  const t = new TemplateTracker();
  t.init(toGray(frame(0, 0)), { x: 48 / 120, y: 68 / 160, w: 16 / 120, h: 20 / 160 });
  let r;
  for (let k = 1; k <= 5; k++) r = t.update(toGray(frame(-k * 3, k * 2)));
  const cx = (r.box.x + r.box.w / 2) * 120, cy = (r.box.y + r.box.h / 2) * 160;
  assert.ok(Math.abs(cx - (56 - 15)) <= 2 && Math.abs(cy - (77 + 10)) <= 2, `tracked to ${cx},${cy}`);
  assert.equal(r.lost, false);
});

test('Find the shot: scan → guide → centre → zoom → ready → capture', () => {
  const f = new ShotFinder();
  const ev = []; f.on('acquire', (e) => ev.push(`acquire:${e.label}`)); f.on('zoom', (e) => ev.push(`zoom:${e.zoom}`)); f.on('capture', (e) => ev.push(`capture:${e.label}`));
  const boat = (x) => [{ key: 'obj:boat', label: 'distant boat', kind: 'vehicle', box: { x, y: 0.5, w: 0.06, h: 0.03 }, score: 0.6 }];
  const presets = [{ factor: 0.5 }, { factor: 1 }, { factor: 2 }, { factor: 5 }];
  f.start(0);
  let vm;
  for (let t = 0; t < 3000; t += 100) { vm = f.update({ candidates: boat(0.2), zoom: { current: 1, presets } }, t); }
  assert.equal(vm.countdown, 1); assert.equal(vm.message, 'Finding your shot...');
  vm = f.update({ candidates: boat(0.2), zoom: { current: 1, presets } }, 3000);
  assert.deepEqual(ev, ['acquire:distant boat']);
  vm = f.update({ track: { box: { x: 0.2, y: 0.5, w: 0.06, h: 0.03 } }, zoom: { current: 1, presets } }, 3100);
  assert.equal(vm.message, 'Move your phone left');
  const at = (x) => ({ track: { box: { x, y: 0.485, w: 0.06, h: 0.03 } }, zoom: { current: 1, presets } });
  vm = f.update(at(0.42), 3200); assert.equal(vm.message, 'Move your phone left', 'hysteresis keeps the instruction until well centred');
  vm = f.update(at(0.47), 3300); assert.equal(vm.message, 'Centered — framing up...');
  for (let t = 3400; t <= 4000; t += 100) vm = f.update(at(0.47), t);
  assert.ok(ev.includes('zoom:2'), ev.join(','));   // like the reference: .5x/1x → 2x for a distant boat
  assert.equal(vm.state, 'FRAMING');
  for (let t = 4100; t <= 4900; t += 100) vm = f.update({ ...at(0.47), motion: { stability: 1 }, lighting: { code: 'LIGHT_GREAT' } }, t);
  assert.equal(vm.state, 'READY'); assert.equal(vm.tone, 'green'); assert.equal(vm.message, 'beautiful light, hold the focus.');
  for (let t = 5000; t <= 6500 && !ev.some((e) => e.startsWith('capture')); t += 100) f.update({ ...at(0.47), motion: { stability: 1 } }, t);
  assert.ok(ev.includes('capture:distant boat')); assert.equal(f.state, 'IDLE');
});

test('Find the shot gives up cleanly when the subject is lost or nothing is found', () => {
  const f = new ShotFinder(); f.start(0);
  for (let t = 0; t <= 3000; t += 100) f.update({ candidates: [] }, t);
  assert.equal(f.state, 'IDLE');
  const g = new ShotFinder(); g.start(0);
  for (let t = 0; t <= 3000; t += 100) g.update({ candidates: [{ key: 'person', label: 'person', kind: 'person', box: { x: 0.4, y: 0.2, w: 0.2, h: 0.6 }, score: 0.9 }] }, t);
  let msg = null; for (let t = 3100; t <= 6000; t += 100) { const vm = g.update({ track: { lost: true } }, t); if (vm.message) msg = vm.message; }
  assert.equal(g.state, 'IDLE'); assert.match(msg, /Lost the person/);
});

test('big subjects need less precise centring', () => {
  const f = new ShotFinder(); f.start(0);
  const person = { key: 'person', label: 'person up close', kind: 'person', box: { x: 0.05, y: 0.12, w: 0.9, h: 0.86 }, score: 0.9 };
  for (let t = 0; t <= 3000; t += 100) f.update({ candidates: [person] }, t);
  const vm = f.update({ track: { box: person.box }, zoom: { current: 1, presets: [{ factor: 1 }] } }, 3100);
  assert.equal(vm.message, 'Centered — framing up...');
});

test('zoom choice: optical presets that keep the subject whole', () => {
  const presets = [{ factor: 0.5 }, { factor: 1 }, { factor: 2 }, { factor: 3 }, { factor: 5 }];
  assert.equal(ShotFinder.chooseZoom({ kind: 'person', box: { w: 0.2, h: 0.3 } }, 1, presets), 2);
  assert.equal(ShotFinder.chooseZoom({ kind: 'person', box: { w: 0.5, h: 0.95 } }, 1, presets), 0.5);
  assert.equal(ShotFinder.chooseZoom({ kind: 'light', box: { w: 0.2, h: 0.1 } }, 1, presets), 2);
  assert.equal(ShotFinder.chooseZoom({ kind: 'object', box: { w: 0.4, h: 0.32 } }, 1, presets), null);
});

test('frame helpers', () => {
  assert.equal(focalLength({ zoom: 2 }), 48); assert.equal(focalLength({ zoom: 0.5 }), 13); assert.equal(focalLength({ selfie: true }), 23);
  assert.equal(specsLine({ zoom: 2, exposureTime: 0.01, iso: 80 }), '48mm   2×   1/100s   ISO80');
  assert.equal(specsLine({ zoom: 1 }), '24mm');
  assert.equal(dateStamp(new Date(2026, 9, 7)), "'26  10  07");
  assert.deepEqual(FRAMES.map((f) => f.name), ['Original', 'White', 'Paper', 'Specs', 'Date']);
});
