import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeFirestore } from '@vayusetu/gcp-clients/testing';

const fakeDb = new FakeFirestore();
vi.mock('@vayusetu/gcp-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vayusetu/gcp-clients')>()),
  getDb: () => fakeDb,
  getAdminAuth: () => {
    throw new Error('AUTH_MODE=mock in tests');
  },
}));

const PUSH_SA = 'pubsub-push@p.iam.gserviceaccount.com';
Object.assign(process.env, {
  NODE_ENV: 'test',
  AUTH_MODE: 'mock',
  GOOGLE_CLOUD_PROJECT: 'vayusetu-test',
  PUBSUB_PUSH_AUTH: 'oidc',
  PUBSUB_PUSH_AUDIENCE: 'aud',
  PUBSUB_PUSH_SA_EMAIL: PUSH_SA,
});

const { buildApp } = await import('../src/app.js');
type FastPathDeps = import('../src/domain/fastPath.js').FastPathDeps;
type DataAdapters = import('../src/adapters/data.js').DataAdapters;

const H3 = '883da1ab2bfffff'; // Delhi
const auth = { authorization: 'Bearer mock-token:rina' };
const NOW = new Date('2026-11-03T02:40:00.000Z');

const data = {
  cellExists: vi.fn(async (h: string) => h === H3),
  history: vi.fn(async () => [{ id: `${H3}_2026-11-03T01`, h3Index: H3 }]),
} as unknown as DataAdapters;

function fastDeps(over: Partial<FastPathDeps> = {}) {
  const publishHotspotUpdated = vi.fn(async () => undefined);
  const deps: FastPathDeps = {
    cellInfo: vi.fn(async (h: string) => (h === H3 ? { corridorId: 'ncr-airshed', hasMonitorWithinRadius: false, nearestStationId: 'anand-vihar' } : undefined)),
    publishHotspotUpdated,
    now: () => NOW,
    logger: { info: () => undefined },
    config: { hiddenMinConfidence: 0.6, alertMinScore: 0.6, minConfidence: 0.5, minAgreement: 0.4 },
    ...over,
  };
  return { deps, publishHotspotUpdated };
}

async function app(deps: FastPathDeps) {
  return buildApp({ data, fastPathDeps: deps, pushTokenVerifier: async () => ({ email: PUSH_SA, email_verified: true }) });
}

const cell = (hour: string, score: number, extra: object = {}) => ({
  id: `${H3}_${hour.slice(0, 13)}`, h3Index: H3, corridorId: 'ncr-airshed', timestampHour: hour,
  hotspotConfidenceScore: score, isHidden: false, classification: 'unknown', contributingSignals: { citizenReportCount: 0 },
  modelVersion: 'hs-v1@1', createdAt: hour, modelScore: score, expireAt: 'x', ...extra,
});

beforeEach(() => fakeDb.reset());

describe('GET /hotspots', () => {
  it('returns the latest scored hour, sorted, without internal fields', async () => {
    fakeDb.collection('hotspots').seed('old', cell('2026-11-03T00:00:00.000Z', 0.99));
    fakeDb.collection('hotspots').seed('a', cell('2026-11-03T01:00:00.000Z', 0.4));
    fakeDb.collection('hotspots').seed('b', { ...cell('2026-11-03T01:00:00.000Z', 0.8), h3Index: '883da1ab29fffff', id: 'b' });
    const res = await (await app(fastDeps().deps)).inject({ method: 'GET', url: '/api/v1/hotspots?corridorId=ncr-airshed', headers: auth });
    expect(res.statusCode).toBe(200);
    const cells = res.json().cells;
    expect(cells.map((c: { hotspotConfidenceScore: number }) => c.hotspotConfidenceScore)).toEqual([0.8, 0.4]);
    expect(cells[0]).not.toHaveProperty('modelScore');
    expect(cells[0]).not.toHaveProperty('expireAt');
  });

  it('filters by bbox and validates it', async () => {
    fakeDb.collection('hotspots').seed('a', cell('2026-11-03T01:00:00.000Z', 0.4));
    const a = await app(fastDeps().deps);
    const inDelhi = await a.inject({ method: 'GET', url: '/api/v1/hotspots?corridorId=ncr-airshed&bbox=28,76.5,29.5,78', headers: auth });
    expect(inDelhi.json().cells).toHaveLength(1);
    const inMumbai = await a.inject({ method: 'GET', url: '/api/v1/hotspots?corridorId=ncr-airshed&bbox=18,72,20,74', headers: auth });
    expect(inMumbai.json().cells).toHaveLength(0);
    expect((await a.inject({ method: 'GET', url: '/api/v1/hotspots?corridorId=ncr-airshed&bbox=1,2,3', headers: auth })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/v1/hotspots', headers: auth })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/v1/hotspots?corridorId=ncr-airshed' })).statusCode).toBe(401);
  });

  it('history: 404 for cells outside every corridor', async () => {
    const a = await app(fastDeps().deps);
    expect((await a.inject({ method: 'GET', url: `/api/v1/hotspots/${H3}/history?range=24h`, headers: auth })).json().points).toHaveLength(1);
    expect((await a.inject({ method: 'GET', url: '/api/v1/hotspots/8a2a1072b59ffff/history', headers: auth })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: `/api/v1/hotspots/${H3}/history?range=1y`, headers: auth })).statusCode).toBe(400);
  });

  it('history is cached 5 min per cell+range; the grid lookup for a day; failures are not cached', async () => {
    let clock = NOW.getTime();
    const d = {
      cellExists: vi.fn(async (h: string) => h === H3),
      history: vi.fn(async () => [{ id: `${H3}_2026-11-03T01`, h3Index: H3 }]),
    } as unknown as DataAdapters & { cellExists: ReturnType<typeof vi.fn>; history: ReturnType<typeof vi.fn> };
    const a = await buildApp({ data: d, now: () => clock, fastPathDeps: fastDeps().deps, pushTokenVerifier: async () => ({ email: PUSH_SA, email_verified: true }) });
    const get = (range = '24h', h = H3) => a.inject({ method: 'GET', url: `/api/v1/hotspots/${h}/history?range=${range}`, headers: auth });

    // A burst of identical requests (one with an upper-case id): one history query, one grid lookup.
    const burst = await Promise.all([get(), get(), get(), get('24h', H3.toUpperCase())]);
    expect(burst.every((r) => r.statusCode === 200)).toBe(true);
    expect(d.history).toHaveBeenCalledTimes(1);
    expect(d.cellExists).toHaveBeenCalledTimes(1);

    await get('7d'); // a different range is a different query
    expect(d.history).toHaveBeenCalledTimes(2);

    clock += 5 * 60_000 + 1; // past the history TTL: refetched; the grid lookup is still cached
    await get();
    expect(d.history).toHaveBeenCalledTimes(3);
    expect(d.cellExists).toHaveBeenCalledTimes(1);

    d.history.mockRejectedValueOnce(new Error('bq down'));
    clock += 5 * 60_000 + 1;
    expect((await get()).statusCode).toBe(500);
    expect((await get()).statusCode).toBe(200); // the failure was not cached
    expect(d.history).toHaveBeenCalledTimes(5);
  });
});

describe('analysis.completed fast path', () => {
  const envelope = (payload: object) => ({ message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } });
  const push = (a: FastifyInstance, payload: object) =>
    a.inject({ method: 'POST', url: '/pubsub/analysis-completed', payload: envelope(payload), headers: { authorization: 'Bearer t' } });

  function seedReport(id: string, analysis: object) {
    fakeDb.collection('submissions').seed(id, { id, h3Index: H3, uploadedAt: '2026-11-03T02:30:00.000Z', userId: id });
    fakeDb.collection('analysisResults').seed(id, {
      submissionId: id, sourceClassification: 'open_waste_burning', severityEstimate: 4, confidenceScore: 0.8,
      needsHumanReview: false, crossValidation: { agreementScore: 0.8 }, ...analysis,
    });
  }

  it('three verified reports + a fresh model score push the cell over the line and publish', async () => {
    fakeDb.collection('hotspots').seed(`${H3}_2026-11-03T01`, cell('2026-11-03T01:00:00.000Z', 0.3));
    for (const id of ['s1', 's2', 's3']) seedReport(id, {});
    seedReport('s4', { needsHumanReview: true }); // not counted
    const { deps, publishHotspotUpdated } = fastDeps();
    const res = await push(await app(deps), { submissionId: 's3', h3Index: H3, corridorId: 'ncr-airshed' });
    expect(res.statusCode).toBe(204);
    const doc = (await fakeDb.collection('hotspots').doc(`${H3}_2026-11-03T02`).get()).data()!;
    expect(doc).toMatchObject({
      classification: 'open_waste_burning', isHidden: true, modelScore: 0.3,
      contributingSignals: { citizenReportCount: 3, avgCitizenSeverity: 4, nearestMonitorId: 'anand-vihar' },
    });
    expect(doc.hotspotConfidenceScore).toBeGreaterThan(0.8); // 1-(0.7)(0.25)
    expect(publishHotspotUpdated).toHaveBeenCalledWith(expect.objectContaining({ hotspotCellId: `${H3}_2026-11-03T02`, corridorId: 'ncr-airshed' }));
  });

  it('one report on a clean cell rescored but below the alert line -> no event', async () => {
    seedReport('s1', { severityEstimate: 2 });
    const { deps, publishHotspotUpdated } = fastDeps();
    await push(await app(deps), { submissionId: 's1', h3Index: H3, corridorId: 'ncr-airshed' });
    expect((await fakeDb.collection('hotspots').doc(`${H3}_2026-11-03T02`).get()).exists).toBe(true);
    expect(publishHotspotUpdated).not.toHaveBeenCalled();
  });

  it('a visible fire counts even when flagged for monitor disagreement (the hidden-hotspot case)', async () => {
    // 27 Sep rehearsal: fire photo, confidence 0.95, flagged because modeled AQI read 64.
    const flagged = { needsHumanReview: true, plumeDetected: true, confidenceScore: 0.95, crossValidation: { agreementScore: 0.2 } };
    seedReport('u1', flagged);
    seedReport('u2', flagged);
    const { deps, publishHotspotUpdated } = fastDeps();
    await push(await app(deps), { submissionId: 'u2', h3Index: H3, corridorId: 'ncr-airshed' });
    const doc = (await fakeDb.collection('hotspots').doc(`${H3}_2026-11-03T02`).get()).data()!;
    expect(doc).toMatchObject({ contributingSignals: { citizenReportCount: 2 } });
    expect(doc.hotspotConfidenceScore).toBeGreaterThanOrEqual(0.6); // two citizens, severity 4
    expect(publishHotspotUpdated).toHaveBeenCalled();
  });

  it('diffuse haze still needs agreement; a flagged plume-less report does not count', async () => {
    seedReport('h1', { sourceClassification: 'vehicular_smog', crossValidation: { agreementScore: 0.2 } });
    seedReport('h2', { sourceClassification: 'open_waste_burning', needsHumanReview: true, plumeDetected: false, confidenceScore: 0.95 });
    seedReport('h3', { sourceClassification: 'open_waste_burning', needsHumanReview: true, plumeDetected: true, confidenceScore: 0.7 });
    const { deps } = fastDeps();
    await push(await app(deps), { submissionId: 'h3', h3Index: H3, corridorId: 'ncr-airshed' });
    expect((await fakeDb.collection('hotspots').doc(`${H3}_2026-11-03T02`).get()).exists).toBe(false); // no qualifying reports
  });

  it('counts distinct citizens, not reports: one person re-reporting cannot alert alone', async () => {
    for (const id of ['r1', 'r2', 'r3']) {
      seedReport(id, { plumeDetected: true, confidenceScore: 0.9 });
      fakeDb.collection('submissions').seed(id, { id, h3Index: H3, uploadedAt: '2026-11-03T02:30:00.000Z', userId: 'same-citizen' });
    }
    const { deps, publishHotspotUpdated } = fastDeps();
    await push(await app(deps), { submissionId: 'r3', h3Index: H3, corridorId: 'ncr-airshed' });
    const doc = (await fakeDb.collection('hotspots').doc(`${H3}_2026-11-03T02`).get()).data()!;
    expect(doc).toMatchObject({ contributingSignals: { citizenReportCount: 1 } });
    expect(publishHotspotUpdated).not.toHaveBeenCalled();
  });

  it('acks unknown cells and contract violations; rejects foreign push tokens', async () => {
    const { deps } = fastDeps();
    const a = await app(deps);
    expect((await push(a, { submissionId: 's', h3Index: '8a2a1072b59ffff', corridorId: 'x' })).statusCode).toBe(204);
    expect((await push(a, { submissionId: 's' })).statusCode).toBe(204);
    const hostile = await buildApp({ data, fastPathDeps: deps, pushTokenVerifier: async () => ({ email: 'evil@x', email_verified: true }) });
    expect((await push(hostile, { submissionId: 's', h3Index: H3, corridorId: 'ncr-airshed' })).statusCode).toBe(401);
  });
});
