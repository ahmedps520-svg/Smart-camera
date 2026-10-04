import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecommendation, SAFE_NOOP } from '../js/reasoning/RecommendationValidator.js';

test('rejects free-form or unknown recommendations', () => {
  assert.deepEqual(validateRecommendation('move left please').value, { ...SAFE_NOOP });
  assert.equal(validateRecommendation({ recommendation: 'FORMAT_DISK' }).ok, false);
  assert.equal(validateRecommendation({ recommendation: 'FORMAT_DISK' }).value.recommendation, 'NONE');
});

test('clamps and validates zoom against device presets', () => {
  const r = validateRecommendation({ recommendation: 'ZOOM', zoom: 7, confidence: 0.9 }, [1, 2, 5]);
  assert.equal(r.ok, false); assert.equal(r.value.zoom, null); assert.equal(r.value.recommendation, 'ZOOM');
  const ok = validateRecommendation({ recommendation: 'ZOOM', zoom: 2, confidence: 0.9, captureReady: 'yes' }, [1, 2, 5]);
  assert.equal(ok.ok, true); assert.equal(ok.value.zoom, 2); assert.equal(ok.value.captureReady, false);
});

test('truncates text fields and bounds confidence', () => {
  const r = validateRecommendation({ recommendation: 'PERFECT', confidence: 7, reason: 'x'.repeat(500), text: 'y'.repeat(100) });
  assert.equal(r.value.confidence, 0); assert.equal(r.value.reason.length, 120); assert.equal(r.value.text.length, 60);
});
