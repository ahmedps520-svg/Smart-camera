import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Debouncer, Hysteresis } from '../js/reasoning/Debouncer.js';

test('debouncer does not flicker between LEFT and RIGHT', () => {
  const d = new Debouncer({ minHoldMs: 900, confirmMs: 320 });
  let t = 0; const seen = [];
  const push = (code) => { const r = d.push(code ? { code, severity: 1 } : null, t); seen.push(r?.code ?? null); t += 50; };
  for (let i = 0; i < 10; i++) push('MOVE_LEFT');               // 500 ms → confirmed and shown
  assert.equal(seen.at(-1), 'MOVE_LEFT');
  for (let i = 0; i < 40; i++) push(i % 2 ? 'MOVE_RIGHT' : 'MOVE_LEFT'); // alternating every 50 ms never confirms
  assert.ok(seen.slice(10).every((c) => c === 'MOVE_LEFT'));
  for (let i = 0; i < 30; i++) push('MOVE_RIGHT');              // sustained → switches after confirm+hold
  assert.equal(seen.at(-1), 'MOVE_RIGHT');
});

test('debouncer lets a higher-severity message through quickly', () => {
  const d = new Debouncer({ minHoldMs: 900, confirmMs: 320 });
  let t = 0;
  for (let i = 0; i < 10; i++) { d.push({ code: 'MOVE_LEFT', severity: 1 }, t); t += 50; }
  let r;
  for (let i = 0; i < 5; i++) { r = d.push({ code: 'MOVE_BACK', severity: 3 }, t); t += 50; }
  assert.equal(r.code, 'MOVE_BACK');
});

test('hysteresis enters above tolerance and exits only below exit ratio', () => {
  const h = new Hysteresis({ enter: 1.0, exit: 0.6 });
  assert.equal(h.test('x', 0.04, 0.05), false);
  assert.equal(h.test('x', 0.06, 0.05), true);
  assert.equal(h.test('x', 0.04, 0.05), true);   // still active inside the band
  assert.equal(h.test('x', 0.02, 0.05), false);  // released below 0.03
});
