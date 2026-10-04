import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoCaptureController } from '../js/capture/AutoCaptureController.js';
import { SubjectTracker } from '../js/analysis/SubjectTracker.js';
import { makePose } from './helpers.js';

const subject = (opts = {}) => new SubjectTracker().update({ people: [makePose(opts)], faces: [], t: 1 }).primary;
const good = { overall: 90, pose: 90, framing: 88, stability: 95, lighting: 80 };

test('captures only after the hold window and countdown, then cools down', () => {
  const ac = new AutoCaptureController({ thresholds: { overall: 82, pose: 75, framing: 72, stability: 78, lighting: 40 }, holdMs: 1000, countdownMs: 900, cooldownMs: 3000, cancelMovement: 0.09, requirePoseChange: 0.12, groupSettleMs: 0 });
  const events = []; ac.on('capture', () => events.push('capture')); ac.on('state', (s) => events.push(s.state));
  ac.setEnabled(true);
  const s = subject();
  for (let t = 0; t <= 2000; t += 50) ac.update({ scores: good, subject: s, group: null, now: t });
  assert.equal(events.filter((e) => e === 'capture').length, 1);
  assert.ok(events.indexOf('HOLDING') < events.indexOf('COUNTDOWN') && events.indexOf('COUNTDOWN') < events.indexOf('capture'));
  ac.captured(2000);
  assert.equal(ac.state, 'COOLDOWN');
  for (let t = 2050; t <= 8000; t += 50) ac.update({ scores: good, subject: s, group: null, now: t });
  assert.equal(events.filter((e) => e === 'capture').length, 1, 'same pose must not be re-captured');
  const changed = subject({ armsUp: true });
  for (let t = 8050; t <= 11000; t += 50) ac.update({ scores: good, subject: changed, group: null, now: t });
  assert.equal(events.filter((e) => e === 'capture').length, 2, 'new pose captured');
});

test('movement during hold cancels and returns to monitoring', () => {
  const ac = new AutoCaptureController({ thresholds: { overall: 82, pose: 75, framing: 72, stability: 78, lighting: 40 }, holdMs: 1000, countdownMs: 900, cooldownMs: 3000, cancelMovement: 0.09, requirePoseChange: 0.12, groupSettleMs: 0 });
  const cancels = []; ac.on('cancel', (c) => cancels.push(c.reason)); let captured = 0; ac.on('capture', () => captured++);
  ac.setEnabled(true);
  const s = subject();
  for (let t = 0; t <= 600; t += 50) ac.update({ scores: good, subject: s, group: null, now: t });
  assert.equal(ac.state, 'HOLDING');
  ac.update({ scores: good, subject: subject({ armsUp: true }), group: null, now: 650 });
  assert.equal(ac.state, 'MONITORING'); assert.equal(cancels[0], 'Moved'); assert.equal(captured, 0);
});

test('low scores never arm; group must be stable', () => {
  const ac = new AutoCaptureController(); ac.setEnabled(true);
  const s = subject();
  for (let t = 0; t <= 3000; t += 50) ac.update({ scores: { ...good, framing: 50 }, subject: s, group: null, now: t });
  assert.equal(ac.state, 'MONITORING');
  for (let t = 3050; t <= 6000; t += 50) ac.update({ scores: good, subject: s, group: { stable: false, issues: [] }, now: t });
  assert.equal(ac.state, 'MONITORING');
});

test('configure merges thresholds instead of replacing them', () => {
  const ac = new AutoCaptureController();
  ac.configure({ holdMs: 1200, thresholds: { overall: 70 } });
  assert.equal(ac.config.holdMs, 1200);
  assert.equal(ac.config.thresholds.overall, 70);
  assert.equal(ac.config.thresholds.pose, 75);
  assert.equal(ac.config.thresholds.framing, 72);
  ac.setEnabled(true);
  const s = subject();
  for (let t = 0; t <= 400; t += 50) ac.update({ scores: { overall: 75, pose: 80, framing: 80, stability: 90, lighting: 60 }, subject: s, group: null, now: t });
  assert.equal(ac.state, 'HOLDING');
});
