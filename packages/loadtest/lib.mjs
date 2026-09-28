// Pure pieces of the load tester (unit-tested in lib.test.mjs).

/** Per-user rate limits enforced by the services (@fastify/rate-limit, keyed on the Firebase uid). */
export const PER_USER_LIMIT_PER_MIN = {
  'submission-service': 60, // /corridors, /analysis, /submissions
  'hotspot-service': 120,
  'forecast-service': 120,
  'alert-service': 120,
  'federation-service': 60,
};

/**
 * Read-only endpoints only. `weight` = share of traffic in the steady mix.
 * Paths may use {corridorId} and {h3Index} (the latter learned from /hotspots).
 */
export const ENDPOINTS = [
  { name: 'hotspots', path: '/hotspots?corridorId={corridorId}', service: 'hotspot-service', weight: 35 },
  { name: 'hotspot-history', path: '/hotspots/{h3Index}/history?range=24h', service: 'hotspot-service', weight: 10 },
  { name: 'forecast-latest', path: '/forecasts/{corridorId}/latest', service: 'forecast-service', weight: 20 },
  { name: 'forecast-history', path: '/forecasts/{corridorId}/history?range=7d', service: 'forecast-service', weight: 5 },
  { name: 'corridors', path: '/corridors', service: 'submission-service', weight: 20 },
  { name: 'corridor', path: '/corridors/{corridorId}', service: 'submission-service', weight: 10 },
];

/** Deterministic weighted choice for a uniform draw u in [0, 1). */
export function pickWeighted(items, u) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let x = u * total;
  for (const item of items) {
    if ((x -= item.weight) < 0) return item;
  }
  return items[items.length - 1];
}

/** Nearest-rank percentile of a numeric array (p in 0..100). */
export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Requests per minute each token would send to each service under a plan.
 * Returns the services whose per-user limit the plan would exceed -- a test
 * that trips the limiter measures the limiter, not capacity.
 */
export function limiterBreaches({ rps, tokens, endpoints = ENDPOINTS }) {
  const total = endpoints.reduce((s, e) => s + e.weight, 0);
  const perService = {};
  for (const e of endpoints) perService[e.service] = (perService[e.service] ?? 0) + (rps * 60 * e.weight) / total / tokens;
  return Object.entries(perService)
    .filter(([svc, perMin]) => perMin > PER_USER_LIMIT_PER_MIN[svc])
    .map(([service, perMin]) => ({ service, perTokenPerMin: Math.round(perMin), limit: PER_USER_LIMIT_PER_MIN[service] }));
}

/** Summary per endpoint: count, status breakdown, p50/p95/p99 latency (ms). */
export function summarize(samples) {
  const by = new Map();
  for (const s of samples) {
    const e = by.get(s.name) ?? { name: s.name, ms: [], status: {} };
    e.ms.push(s.ms);
    e.status[s.status] = (e.status[s.status] ?? 0) + 1;
    by.set(s.name, e);
  }
  return [...by.values()].map((e) => ({
    name: e.name,
    count: e.ms.length,
    status: e.status,
    p50: percentile(e.ms, 50),
    p95: percentile(e.ms, 95),
    p99: percentile(e.ms, 99),
    errorRate: Object.entries(e.status).filter(([code]) => !code.startsWith('2')).reduce((s, [, n]) => s + n, 0) / e.ms.length,
  }));
}

/** Pass/fail against the thresholds. `allow429` for the limiter scenario. */
export function verdict(summary, { p95Ms, maxErrorRate, allow429 = false }) {
  const failures = [];
  for (const e of summary) {
    const errors = Object.entries(e.status)
      .filter(([code]) => !code.startsWith('2') && !(allow429 && code === '429'))
      .reduce((s, [, n]) => s + n, 0);
    if (errors / e.count > maxErrorRate) failures.push(`${e.name}: error rate ${(100 * errors / e.count).toFixed(1)}% > ${100 * maxErrorRate}%`);
    if (!allow429 && e.p95 > p95Ms) failures.push(`${e.name}: p95 ${e.p95} ms > ${p95Ms} ms`);
  }
  return failures;
}
