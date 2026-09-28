import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, limiterBreaches, percentile, pickWeighted, summarize, verdict } from './lib.mjs';

test('only read-only paths are ever targeted', () => {
  for (const e of ENDPOINTS) assert.doesNotMatch(e.path, /retry|clarify|import|status|assign|register|upload/);
});

test('percentile uses nearest rank', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 95), 95);
  assert.equal(percentile(xs, 99), 99);
  assert.equal(percentile([7], 95), 7);
});

test('weighted pick covers the mix by weight', () => {
  const items = [{ n: 'a', weight: 1 }, { n: 'b', weight: 3 }];
  assert.equal(pickWeighted(items, 0.0).n, 'a');
  assert.equal(pickWeighted(items, 0.24).n, 'a');
  assert.equal(pickWeighted(items, 0.26).n, 'b');
  assert.equal(pickWeighted(items, 0.999).n, 'b');
});

test('flags plans that would trip the per-user limiter', () => {
  // 5 rps, 1 token: submission-service gets 30% of 300/min = 90/min > 60.
  const b = limiterBreaches({ rps: 5, tokens: 1 });
  assert.ok(b.some((x) => x.service === 'submission-service' && x.perTokenPerMin === 90));
  // Spread over 2 tokens: 45/min each, under the limit.
  assert.deepEqual(limiterBreaches({ rps: 5, tokens: 2 }), []);
});

test('summary and verdict', () => {
  const samples = [
    ...Array.from({ length: 99 }, () => ({ name: 'hotspots', status: '200', ms: 100 })),
    { name: 'hotspots', status: '503', ms: 2000 },
  ];
  const [s] = summarize(samples);
  assert.equal(s.count, 100);
  assert.equal(s.errorRate, 0.01);
  assert.deepEqual(verdict([s], { p95Ms: 1500, maxErrorRate: 0.01 }), []);
  assert.equal(verdict([s], { p95Ms: 50, maxErrorRate: 0 }).length, 2);
  const limited = summarize([{ name: 'corridors', status: '429', ms: 5 }]);
  assert.deepEqual(verdict(limited, { p95Ms: 1, maxErrorRate: 0, allow429: true }), []);
});
