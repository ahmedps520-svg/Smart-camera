import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectCandidates, saliencyCandidate, describe, peopleCandidates } from '../js/ai/Candidates.js';
import { TemplateTracker, toGray } from '../js/ai/TemplateTracker.js';
import { ShotFinder, planShot } from '../js/ai/ShotFinder.js';
import { GlobalMotion } from '../js/ai/GlobalMotion.js';
import { AI_STYLES } from '../js/config/defaults.js';
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

test('Find the shot: one frame → anchored box → line up → zoom → capture', () => {
  const f = new ShotFinder();
  const ev = []; f.on('zoom', (e) => ev.push(`zoom:${e.zoom}`)); f.on('capture', (e) => ev.push(`capture:${e.label}:${e.crop ? 'crop' : 'zoomed'}`));
  const presets = [{ factor: 0.5 }, { factor: 1 }, { factor: 2 }, { factor: 5 }];
  const boat = [{ key: 'obj:boat', label: 'distant boat', kind: 'vehicle', box: { x: 0.2, y: 0.5, w: 0.06, h: 0.03 }, score: 0.6 }];
  f.start(0);
  let vm = f.update({ candidates: boat, fresh: false, zoom: { current: 1, presets } }, 50);
  assert.equal(vm.state, 'PLAN', 'waits for a complete analysis frame');
  vm = f.update({ candidates: boat, fresh: true, zoom: { current: 1, presets } }, 100);
  assert.equal(vm.state, 'AIM'); assert.equal(vm.label, 'distant boat');
  const box0 = { ...vm.box };
  assert.ok(box0.x + box0.w / 2 < 0.4, 'box is around the boat, left of centre');
  assert.match(vm.message, /left/);
  // The phone pans left: the scene (and the box) shifts right. The box stays glued to the scene.
  vm = f.update({ shift: { dx: 0.1, dy: 0, ok: true }, zoom: { current: 1, presets } }, 200);
  assert.ok(Math.abs(vm.box.x - (box0.x + 0.1)) < 1e-9, 'box follows the scene, not the subject detector');
  const toCentre = 0.5 - (vm.box.x + vm.box.w / 2);
  vm = f.update({ shift: { dx: toCentre, dy: 0.5 - (vm.box.y + vm.box.h / 2), ok: true }, zoom: { current: 1, presets } }, 300);
  assert.equal(vm.aligned, true);
  f.update({ zoom: { current: 1, presets } }, 600);
  assert.deepEqual(ev, ['zoom:2']);
  f.update({ zoom: { current: 2, presets } }, 1100);
  assert.deepEqual(ev, ['zoom:2', 'capture:distant boat:zoomed']); assert.equal(f.state, 'IDLE');
});

test('Find the shot never takes long: not lined up in time → shoot and crop to the box', () => {
  const f = new ShotFinder(); let got = null; f.on('capture', (e) => { got = e; });
  const person = [{ key: 'person', label: 'person', kind: 'person', box: { x: 0.65, y: 0.3, w: 0.15, h: 0.4 }, score: 0.9 }];
  f.start(0); f.update({ candidates: person, fresh: true, zoom: { current: 1, presets: [{ factor: 1 }, { factor: 2 }] } }, 10);
  for (let t = 100; t <= 4100; t += 100) f.update({ shift: { dx: 0, dy: 0, ok: true } }, t);
  assert.ok(got && got.crop, 'captured with the box as crop'); assert.equal(got.label, 'person');
  assert.ok(got.focusY > 0 && got.focusY < 1);
});

test('nothing detected still gives a framing; Scenic widens first', () => {
  const plan = planShot({ candidates: [], current: 1, presets: [{ factor: 1 }, { factor: 2 }] });
  assert.equal(plan.label, 'best framing'); assert.ok(plan.box.w > 0.5);
  const f = new ShotFinder(); const zooms = []; f.on('zoom', (e) => zooms.push(e.zoom));
  f.start(0, AI_STYLES.find((s) => s.id === 'scenic'));
  const vm = f.update({ candidates: [], fresh: true, zoom: { current: 1, presets: [{ factor: 0.5 }, { factor: 1 }] } }, 10);
  assert.deepEqual(zooms, [0.5]); assert.equal(vm.message, 'Going wide...');
  assert.equal(f.update({ candidates: [], fresh: true, zoom: { current: 0.5, presets: [{ factor: 0.5 }, { factor: 1 }] } }, 200).state, 'PLAN', 'waits for the wide lens');
  assert.equal(f.update({ candidates: [], fresh: true, zoom: { current: 0.5, presets: [{ factor: 0.5 }, { factor: 1 }] } }, 600).state, 'AIM');
});

test('camera motion estimate measures how the scene shifted', () => {
  // Non-repeating "scene": smooth value noise (real scenes do not repeat like a sine wave).
  const N = 64, grid = Array.from({ length: N * N }, (_, i) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1);
  const noise = (X, Y) => { const gx = X / 9, gy = Y / 9, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0; const g = (i, j) => grid[(((j % N) + N) % N) * N + (((i % N) + N) % N)]; return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy; };
  const tex = (ox, oy) => { const w = 192, h = 256, d = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = 255 * noise(x - ox + 40, y - oy + 40); return { data: d, w, h }; };
  const gm = new GlobalMotion();
  assert.equal(gm.push(tex(0, 0)).ok, false);
  const r = gm.push(tex(12, -8));
  assert.ok(Math.abs(r.dx - 12 / 192) < 0.012 && Math.abs(r.dy + 8 / 256) < 0.012, JSON.stringify(r));
  assert.equal(r.ok, true);
});

test('frame helpers', () => {
  assert.equal(focalLength({ zoom: 2 }), 48); assert.equal(focalLength({ zoom: 0.5 }), 13); assert.equal(focalLength({ selfie: true }), 23);
  assert.equal(specsLine({ zoom: 2, exposureTime: 0.01, iso: 80 }), '48mm   2×   1/100s   ISO80');
  assert.equal(specsLine({ zoom: 1 }), '24mm');
  assert.equal(dateStamp(new Date(2026, 9, 7)), "'26  10  07");
  assert.deepEqual(FRAMES.map((f) => f.name), ['Original', 'White', 'Paper', 'Specs', 'Date', 'Cinema']);
});
