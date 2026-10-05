import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoCaptureController } from '../js/capture/AutoCaptureController.js';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { makePose } from './helpers.js';

const subject = (opts = {}) => new SubjectTracker().update({ people: [makePose(opts)], faces: [], t: 1 }).primary;
const good = { overall: 85, pose: 85, framing: 70, stability: 90, lighting: 70 };
const run = (ac, from, to, fn) => { for (let t = from; t <= to; t += 50) ac.update({ group: null, ...fn(t), now: t }); };

function make() {
  const ac = new AutoCaptureController();
  const ev = []; ac.on('capture', () => ev.push('capture')); ac.on('state', (s) => ev.push(s.state)); ac.on('cancel', (c) => ev.push(`cancel:${c.reason}`));
  ac.setEnabled(true);
  return { ac, ev };
}

test('captures after hold + countdown with realistic scores', () => {
  const { ac, ev } = make();
  const s = subject();
  run(ac, 0, 2000, () => ({ scores: good, subject: s }));
  assert.equal(ev.filter((e) => e === 'capture').length, 1, ev.join(','));
  assert.ok(ev.indexOf('HOLDING') < ev.indexOf('COUNTDOWN') && ev.indexOf('COUNTDOWN') < ev.indexOf('capture'));
});

test('landmark jitter does not cancel the hold', () => {
  const { ac, ev } = make();
  run(ac, 0, 2500, (t) => ({ scores: good, subject: subject({ cx: 0.5 + Math.sin(t) * 0.006, headY: 0.2 + Math.cos(t) * 0.006 }) }));
  assert.equal(ev.filter((e) => e.startsWith('cancel')).length, 0, ev.join(','));
  assert.equal(ev.filter((e) => e === 'capture').length, 1);
});

test('brief dips below the threshold are tolerated, long ones cancel', () => {
  const { ac, ev } = make();
  const s = subject();
  run(ac, 0, 400, () => ({ scores: good, subject: s }));
  run(ac, 450, 650, () => ({ scores: { ...good, overall: 60 }, subject: s }));   // 200 ms dip
  assert.equal(ac.state, 'HOLDING');
  run(ac, 700, 2000, () => ({ scores: good, subject: s }));
  assert.equal(ev.filter((e) => e === 'capture').length, 1);

  const b = make();
  run(b.ac, 0, 400, () => ({ scores: good, subject: s }));
  run(b.ac, 450, 1200, () => ({ scores: { ...good, overall: 60 }, subject: s }));
  assert.equal(b.ac.state, 'MONITORING');
  assert.ok(b.ev.includes('cancel:Conditions changed'));
});

test('real movement cancels the hold', () => {
  const { ac, ev } = make();
  run(ac, 0, 400, () => ({ scores: good, subject: subject() }));
  assert.equal(ac.state, 'HOLDING');
  ac.update({ scores: good, subject: subject({ armsUp: true }), group: null, now: 450 });
  assert.equal(ac.state, 'MONITORING');
  assert.ok(ev.includes('cancel:Moved'));
});

test('same pose is not re-shot until it changes or repeatAfterMs passes', () => {
  const { ac, ev } = make();
  const s = subject();
  run(ac, 0, 2000, () => ({ scores: good, subject: s }));
  ac.markCaptured(2000);
  run(ac, 2050, 7000, () => ({ scores: good, subject: s }));
  assert.equal(ev.filter((e) => e === 'capture').length, 1, 'same pose blocked');
  assert.deepEqual(ac.blockers, ['same pose']);
  run(ac, 7050, 9500, () => ({ scores: good, subject: subject({ armsUp: true }) }));
  assert.equal(ev.filter((e) => e === 'capture').length, 2, 'new pose captured');
  ac.markCaptured(9500);
  run(ac, 9550, 20000, () => ({ scores: good, subject: subject({ armsUp: true }) }));
  assert.equal(ev.filter((e) => e === 'capture').length, 3, 'same pose again after repeatAfterMs');
});

test('reports which scores block capture; unstable group never arms', () => {
  const { ac } = make();
  const s = subject();
  run(ac, 0, 3000, () => ({ scores: { ...good, framing: 30, stability: 40 }, subject: s }));
  assert.equal(ac.state, 'MONITORING');
  assert.deepEqual(ac.blockers, ['framing', 'stability']);
  run(ac, 3050, 6000, () => ({ scores: good, subject: s, group: { stable: false, issues: [] } }));
  assert.equal(ac.state, 'MONITORING');
  assert.ok(ac.blockers.includes('group'));
});

test('configure merges thresholds instead of replacing them', () => {
  const ac = new AutoCaptureController();
  ac.configure({ holdMs: 1200, thresholds: { overall: 70 } });
  assert.equal(ac.config.holdMs, 1200);
  assert.equal(ac.config.thresholds.overall, 70);
  assert.equal(ac.config.thresholds.pose, 62);
});

test('selfie (head and shoulders only) can auto capture', () => {
  const { ac, ev } = make();
  const t = new SubjectTracker();
  const p = makePose({ cx: 0.5, headY: 0.15, height: 1.6 });
  for (const i of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 15, 16, 17, 18, 19, 20, 21, 22]) p.landmarks[i].visibility = 0.05;
  const s = t.update({ people: [p], faces: [], t: 1 }).primary;
  run(ac, 0, 2000, () => ({ scores: good, subject: s }));
  assert.equal(ev.filter((e) => e === 'capture').length, 1);
});
