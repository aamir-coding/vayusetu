#!/usr/bin/env node
// Read-only load test for the VayuSetu API (GET endpoints only, never writes).
// Zero dependencies (Node 20+ fetch). See README.md before running.
//
//   TOKENS="<id token 1>,<id token 2>" node packages/loadtest/loadtest.mjs --scenario steady --rps 5 --duration 60
//
// Scenarios:
//   smoke    1 request per endpoint; checks auth + routing + shapes
//   steady   open-model arrivals at --rps for --duration s over the weighted mix
//   limiter  one token, bursts one service past its per-user limit; expects
//            clean 429 RATE_LIMITED ApiErrors, never 5xx
import { ENDPOINTS, limiterBreaches, pickWeighted, summarize, verdict } from './lib.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = (process.env.BASE_URL ?? 'https://vayusetu-ncr-dev-admin.web.app/api/v1').replace(/\/$/, '');
const CORRIDOR = process.env.CORRIDOR_ID ?? 'ncr-airshed';
const TOKENS = (process.env.TOKENS ?? process.env.TOKEN ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const scenario = arg('scenario', 'smoke');
const rps = Number(arg('rps', '3'));
const duration = Number(arg('duration', '60'));
const p95Ms = Number(arg('p95', '1500'));
const maxErrorRate = Number(arg('max-error-rate', '0.01'));

if (TOKENS.length === 0) {
  console.error('Set TOKENS (comma-separated Firebase ID tokens) or TOKEN. See README.md -- tokens are never logged.');
  process.exit(2);
}
if (!['smoke', 'steady', 'limiter'].includes(scenario)) {
  console.error(`unknown --scenario ${scenario}`);
  process.exit(2);
}
// Guard rails: this is a dev project on credits.
if (!flag('i-know') && (rps > 50 || duration > 600)) {
  console.error('Refusing > 50 rps or > 600 s without --i-know (dev project, credits).');
  process.exit(2);
}

let h3Index;
let tokenIx = 0;
const nextToken = () => TOKENS[tokenIx++ % TOKENS.length];

async function hit(endpoint, token = nextToken()) {
  const path = endpoint.path.replace('{corridorId}', CORRIDOR).replace('{h3Index}', h3Index ?? 'none');
  const t0 = performance.now();
  let status = 'ERR';
  let body;
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    status = String(res.status);
    body = await res.json().catch(() => undefined);
  } catch {
    status = 'ERR';
  }
  return { name: endpoint.name, status, ms: Math.round(performance.now() - t0), body };
}

async function discover() {
  const r = await hit(ENDPOINTS.find((e) => e.name === 'hotspots'));
  if (r.status === '401') {
    console.error('401 from /hotspots: the token is missing, expired (tokens last 1 h) or for another project.');
    process.exit(2);
  }
  h3Index = r.body?.cells?.[0]?.h3Index;
  if (!h3Index) console.warn('No hotspot cells returned; hotspot-history will 404 (expected on an empty grid).');
}

async function steady(endpoints) {
  const samples = [];
  const inflight = new Set();
  const total = Math.round(rps * duration);
  const start = performance.now();
  for (let i = 0; i < total; i++) {
    const due = start + (i * 1000) / rps;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    const p = hit(pickWeighted(endpoints, Math.random())).then((s) => {
      samples.push(s);
      inflight.delete(p);
    });
    inflight.add(p);
    if (i % Math.max(1, Math.round(rps * 10)) === 0) process.stdout.write(`\r${i}/${total} sent, ${inflight.size} in flight   `);
  }
  await Promise.all(inflight);
  process.stdout.write('\n');
  return samples;
}

function report(samples, opts) {
  const summary = summarize(samples);
  console.table(summary.map(({ name, count, p50, p95, p99, errorRate, status }) => ({
    endpoint: name, count, p50, p95, p99, 'err%': (100 * errorRate).toFixed(1), status: JSON.stringify(status),
  })));
  const failures = verdict(summary, opts);
  console.log(failures.length ? `FAIL\n  ${failures.join('\n  ')}` : 'PASS');
  process.exitCode = failures.length ? 1 : 0;
}

await discover();
console.log(`${scenario} -> ${BASE} (${CORRIDOR}), ${TOKENS.length} token(s)`);

if (scenario === 'smoke') {
  const samples = [];
  for (const e of ENDPOINTS) samples.push(await hit(e));
  report(samples, { p95Ms: 10_000, maxErrorRate: 0 });
} else if (scenario === 'steady') {
  const breaches = limiterBreaches({ rps, tokens: TOKENS.length });
  if (breaches.length && !flag('i-know')) {
    console.error('This plan would trip the per-user rate limiter (you would measure the limiter, not capacity):');
    for (const b of breaches) console.error(`  ${b.service}: ${b.perTokenPerMin}/min per token > 80% of its ${b.limit}/min limit (random bursts would cross it)`);
    console.error(`Lower --rps or add tokens (TOKENS=a,b,c). Pass --i-know to run anyway.`);
    process.exit(2);
  }
  report(await steady(ENDPOINTS), { p95Ms, maxErrorRate });
} else {
  // limiter: 1 token, 80 requests in ~20 s to submission-service (limit 60/min).
  const corridors = ENDPOINTS.find((e) => e.name === 'corridors');
  const token = TOKENS[0];
  const samples = [];
  for (let i = 0; i < 80; i++) {
    samples.push(await hit(corridors, token));
    await new Promise((ok) => setTimeout(ok, 250));
  }
  const limited = samples.filter((s) => s.status === '429');
  const clean = limited.every((s) => s.body?.error?.code === 'RATE_LIMITED');
  console.log(`429s: ${limited.length} (expected >= 15), all ApiError RATE_LIMITED: ${clean}`);
  report(samples, { p95Ms, maxErrorRate, allow429: true });
  if (limited.length < 15 || !clean) process.exitCode = 1;
  // The first token's one-minute window is now spent; a steady run started
  // at once inherits it as 429s (29 Sep, Mumbai-Pune).
  console.log('Wait 60 s before a steady run: this token is still rate-limited for up to a minute.');
}
