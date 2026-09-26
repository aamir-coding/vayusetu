import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { latLngToCell } from 'h3-js';
import type { Alert, Corridor, HotspotCell } from '@vayusetu/shared-types';
import { FakeFirestore } from '@vayusetu/gcp-clients/testing';

const fakeDb = new FakeFirestore();

vi.mock('@vayusetu/gcp-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vayusetu/gcp-clients')>()),
  getDb: () => fakeDb,
  getAdminAuth: () => {
    throw new Error('getAdminAuth() must not be called in AUTH_MODE=mock');
  },
  getAdminMessaging: () => {
    throw new Error('getAdminMessaging() must not be called -- tests inject the gateway');
  },
}));

const PUSH_SA = 'pubsub-push-test@vayusetu-test.iam.gserviceaccount.com';
Object.assign(process.env, {
  AUTH_MODE: 'mock',
  NODE_ENV: 'test',
  GOOGLE_CLOUD_PROJECT: 'vayusetu-test',
  PUBSUB_PUSH_AUTH: 'oidc',
  PUBSUB_PUSH_AUDIENCE: 'vayusetu-alert-service-test',
  PUBSUB_PUSH_SA_EMAIL: PUSH_SA,
  PUSH_CHANNEL_MODE: 'stub',
});

const { buildApp } = await import('../src/app.js');
const { templateBriefingGenerator } = await import('../src/domain/briefing.js');
const { createNotificationGateway, createStubChannel } = await import('../src/notifications/gateway.js');
const { findRecipients } = await import('../src/notifications/recipients.js');
const { requireOfficial } = await import('../src/plugins/auth.js');
const { GeocodingError } = await import('@vayusetu/gcp-clients');
type Deps = import('../src/pipeline/alertPipeline.js').PipelineDeps;
type Adapter = import('../src/notifications/types.js').ChannelAdapter;

// ---------------------------------------------------------------- fixtures
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const H3_CENTRAL = latLngToCell(28.6329, 77.2195, 8);

const NCR: Corridor = {
  id: 'ncr-airshed',
  name: 'Delhi-NCR Airshed',
  states: ['DL', 'HR', 'UP', 'RJ'],
  boundaryGeoJsonStorageUrl: 'gs://x/ncr.geojson',
  population: 46_000_000,
  monitoringStationIds: [],
  grapFrameworkActive: true,
  grapThresholds: {
    stage_1: { aqiMin: 201, aqiMax: 300 },
    stage_2: { aqiMin: 301, aqiMax: 400 },
    stage_3: { aqiMin: 401, aqiMax: 450 },
    stage_4: { aqiMin: 451, aqiMax: 500 },
  },
  createdAt: '2026-01-01T00:00:00.000Z',
};

function official(uid: string, role: string, jurisdiction: object, extra: object = {}) {
  fakeDb.collection('users').seed(uid, {
    uid, displayName: uid, role, preferredLanguage: 'en-IN', jurisdiction, fcmTokens: [`tok-${uid}`],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
  });
}

function seedCell(hour: string, score: number, h3 = H3_CENTRAL): HotspotCell {
  const cell: HotspotCell = {
    id: `${h3}_${hour}`, h3Index: h3, corridorId: 'ncr-airshed', timestampHour: `${hour}:00:00.000Z`,
    hotspotConfidenceScore: score, isHidden: true, classification: 'open_waste_burning',
    contributingSignals: { citizenReportCount: 6, avgCitizenSeverity: 4.2, satelliteAOD: 0.61 },
    modelVersion: 'rough-v0', createdAt: `${hour}:05:00.000Z`,
  };
  fakeDb.collection('hotspots').seed(cell.id, cell as never);
  return cell;
}

function seedAlert(id: string, over: Partial<Alert>) {
  const base: Alert = {
    id, type: 'hotspot', sourceRef: 'x', corridorId: 'ncr-airshed', severity: 'warning', impliedGrapStage: 'none',
    title: 't', description: 'd', recommendedActions: ['a', 'b'], citedSignals: [], publicAdvisory: 'p',
    assignedJurisdiction: { stateCode: 'DL', districtCode: 'DL-CENTRAL' }, status: 'new',
    statusHistory: [{ status: 'new', byUserId: 'system', at: '2026-09-24T00:00:00.000Z' }],
    notificationsSent: [], createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
  };
  fakeDb.collection('alerts').seed(id, { ...base, ...over } as never);
}

// ------------------------------------------------------------ test harness
let app: FastifyInstance;
let clock: Date;
let pushSends: Array<{ alertId: string; to: string[] }>;
let resolveJurisdiction: ReturnType<typeof vi.fn>;

function makeDeps(): Deps {
  const push: Adapter = {
    channel: 'push',
    mode: 'live',
    async send(rs, m) {
      pushSends.push({ alertId: m.alertId, to: rs.map((r) => r.uid).sort() });
      return rs.map((r) => ({ channel: 'push', to: r.uid, status: 'sent', simulated: false }));
    },
  };
  return {
    briefing: templateBriefingGenerator,
    gateway: createNotificationGateway({
      adapters: { push, sms: createStubChannel('sms', silent), whatsapp: createStubChannel('whatsapp', silent) },
      dashboardBaseUrl: 'http://localhost:5174',
      logger: silent,
    }),
    resolveJurisdiction: resolveJurisdiction as unknown as Deps['resolveJurisdiction'],
    findRecipients,
    hotspotThresholds: { watch: 0.6, warning: 0.75, critical: 0.9 },
    suppressionWindowHours: 24,
    fallbackStateCode: 'DL',
    now: () => clock,
    logger: silent,
  };
}

const verifier = async (token: string, audience: string) => {
  if (audience !== 'vayusetu-alert-service-test') throw new Error('bad audience');
  if (token === 'good') return { email: PUSH_SA, email_verified: true };
  if (token === 'other-sa') return { email: 'attacker@evil.iam.gserviceaccount.com', email_verified: true };
  throw new Error('bad signature');
};

function push(topic: 'hotspot-updated' | 'forecast-updated', payload: unknown, token = 'good') {
  return app.inject({
    method: 'POST',
    url: `/pubsub/${topic}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { message: { data: Buffer.from(JSON.stringify(payload)).toString('base64'), messageId: 'm-1' }, subscription: 's' },
  });
}
const hotspotEvent = (cell: HotspotCell, score = cell.hotspotConfidenceScore) =>
  push('hotspot-updated', { hotspotCellId: cell.id, corridorId: cell.corridorId, hotspotConfidenceScore: score });

const auth = (uid: string) => ({ authorization: `Bearer mock-token:${uid}` });
const alertDoc = (id: string) => fakeDb.collection('alerts').all().find((a) => a.id === id)?.data as unknown as Alert | undefined;

beforeEach(async () => {
  fakeDb.reset();
  clock = new Date('2026-09-24T06:10:00.000Z');
  pushSends = [];
  resolveJurisdiction = vi.fn(async () => ({ stateCode: 'DL', districtCode: 'DL-CENTRAL' }));
  fakeDb.collection('corridors').seed('ncr-airshed', NCR as never);
  fakeDb.collection('corridors').seed('mumbai-pune-corridor', {
    ...NCR, id: 'mumbai-pune-corridor', states: ['MH'], grapFrameworkActive: false, grapThresholds: undefined,
  } as never);
  official('mock-deshmukh', 'district_admin', { stateCode: 'DL', districtCode: 'DL-CENTRAL' }, { phoneNumber: '+919800000001' });
  official('mock-iyer', 'state_admin', { stateCode: 'DL' });
  official('north-officer', 'district_admin', { stateCode: 'DL', districtCode: 'DL-NORTH' });
  fakeDb.collection('users').seed('citizen-rina', { uid: 'citizen-rina', role: 'citizen', fcmTokens: [] } as never);
  app = await buildApp({ pipelineDeps: makeDeps(), pushTokenVerifier: verifier });
});

afterEach(async () => {
  await app.close();
});

// ------------------------------------------------------------------- tests
describe('Pub/Sub push authentication', () => {
  it('401s with no token, a forged token, or a valid token from the WRONG service account', async () => {
    const cell = seedCell('2026-09-24T06', 0.92);
    const noToken = await app.inject({ method: 'POST', url: '/pubsub/hotspot-updated', payload: {} });
    expect(noToken.statusCode).toBe(401);
    expect((await push('hotspot-updated', {}, 'forged')).statusCode).toBe(401);
    expect((await push('hotspot-updated', { hotspotCellId: cell.id, corridorId: 'ncr-airshed', hotspotConfidenceScore: 0.92 }, 'other-sa')).statusCode).toBe(401);
  });

  it('ACKs (204) malformed envelopes and contract-violating payloads instead of retrying forever', async () => {
    const bad = await app.inject({ method: 'POST', url: '/pubsub/hotspot-updated', headers: { authorization: 'Bearer good' }, payload: { nope: 1 } });
    expect(bad.statusCode).toBe(204);
    expect((await push('hotspot-updated', { hotspotCellId: 'x' })).statusCode).toBe(204);
    expect(fakeDb.collection('alerts').all()).toHaveLength(0);
  });
});

describe('hotspot.updated pipeline', () => {
  it('creates a deterministic-id, jurisdiction-routed alert and notifies exactly the officials who can see it', async () => {
    const cell = seedCell('2026-09-24T06', 0.92);
    expect((await hotspotEvent(cell)).statusCode).toBe(204);

    const alert = alertDoc(`hotspot_${cell.id}`)!;
    expect(alert).toMatchObject({
      type: 'hotspot', severity: 'critical', sourceRef: cell.id, h3Index: H3_CENTRAL, status: 'new',
      assignedJurisdiction: { stateCode: 'DL', districtCode: 'DL-CENTRAL' },
      statusHistory: [{ status: 'new', byUserId: 'system' }],
    });
    expect(pushSends).toEqual([{ alertId: alert.id, to: ['mock-deshmukh', 'mock-iyer'] }]); // not north-officer
    // critical -> push+sms+whatsapp dispatched, but only real (push) deliveries are persisted
    expect(alert.notificationsSent.map((n) => `${n.channel}:${n.to}:${n.status}`).sort()).toEqual([
      'push:mock-deshmukh:sent',
      'push:mock-iyer:sent',
    ]);
  });

  it('is idempotent: a redelivered event neither duplicates the alert nor re-pages anyone', async () => {
    const cell = seedCell('2026-09-24T06', 0.92);
    await hotspotEvent(cell);
    await hotspotEvent(cell);
    expect(fakeDb.collection('alerts').all()).toHaveLength(1);
    expect(pushSends).toHaveLength(1);
  });

  it('idempotency holds even after the alert is dismissed, and short-circuits before geocoding/briefing', async () => {
    // Once dismissed, the suppression rule no longer applies (not open), so
    // only the deterministic-id check stands between a redelivery and a
    // wasted geocode + briefing call (a Gemini 3.1 Pro call from Week 3).
    const cell = seedCell('2026-09-24T06', 0.92);
    await hotspotEvent(cell);
    await fakeDb.collection('alerts').doc(`hotspot_${cell.id}`).update({ status: 'dismissed' });
    await hotspotEvent(cell);
    expect(fakeDb.collection('alerts').all()).toHaveLength(1);
    expect(pushSends).toHaveLength(1);
    expect(resolveJurisdiction).toHaveBeenCalledTimes(1);
  });

  it('filters on the payload score without any read, then re-decides on the RE-READ document', async () => {
    const below = await push('hotspot-updated', { hotspotCellId: 'never-written', corridorId: 'ncr-airshed', hotspotConfidenceScore: 0.3 });
    expect(below.statusCode).toBe(204); // acked without touching the missing doc

    const cell = seedCell('2026-09-24T06', 0.5); // stored truth: below threshold
    await hotspotEvent(cell, 0.95); // stale/wrong payload claims critical
    expect(fakeDb.collection('alerts').all()).toHaveLength(0);
  });

  it('ACKs an event whose HotspotCell doc does not exist (non-retryable)', async () => {
    const res = await push('hotspot-updated', { hotspotCellId: 'ghost_2026-09-24T06', corridorId: 'ncr-airshed', hotspotConfidenceScore: 0.95 });
    expect(res.statusCode).toBe(204);
  });

  it('NACKs (500) on a transient geocoding failure and writes nothing, so Pub/Sub retries', async () => {
    resolveJurisdiction.mockRejectedValueOnce(new GeocodingError('timeout', 'transient'));
    const cell = seedCell('2026-09-24T06', 0.92);
    expect((await hotspotEvent(cell)).statusCode).toBe(500);
    expect(fakeDb.collection('alerts').all()).toHaveLength(0);
    expect((await hotspotEvent(cell)).statusCode).toBe(204); // the retry succeeds
    expect(fakeDb.collection('alerts').all()).toHaveLength(1);
  });

  it('routes an un-geocodable cell to state level instead of dropping it', async () => {
    resolveJurisdiction.mockRejectedValueOnce(new GeocodingError('none', 'no_result'));
    const cell = seedCell('2026-09-24T06', 0.8);
    await hotspotEvent(cell);
    expect(alertDoc(`hotspot_${cell.id}`)!.assignedJurisdiction).toEqual({ stateCode: 'DL' });
    expect(pushSends[0]!.to).toEqual(['mock-iyer']);
  });

  it('suppresses a same-cell alert of equal severity next hour, but escalates on higher severity', async () => {
    await hotspotEvent(seedCell('2026-09-24T06', 0.8)); // warning
    clock = new Date('2026-09-24T07:10:00.000Z');
    await hotspotEvent(seedCell('2026-09-24T07', 0.78)); // warning again -> suppressed
    expect(fakeDb.collection('alerts').all()).toHaveLength(1);

    clock = new Date('2026-09-24T08:10:00.000Z');
    await hotspotEvent(seedCell('2026-09-24T08', 0.93)); // critical -> escalation
    expect(fakeDb.collection('alerts').all().map((a) => (a.data as unknown as Alert).severity).sort()).toEqual(['critical', 'warning']);
  });

  it('stops suppressing once the open alert is older than the window, or resolved', async () => {
    await hotspotEvent(seedCell('2026-09-24T06', 0.8));
    clock = new Date('2026-09-25T07:10:00.000Z'); // 25h later
    await hotspotEvent(seedCell('2026-09-25T07', 0.8));
    expect(fakeDb.collection('alerts').all()).toHaveLength(2);
  });

  it('resumes dispatch when a previous attempt created the alert but crashed before notifying', async () => {
    const cell = seedCell('2026-09-24T06', 0.92);
    seedAlert(`hotspot_${cell.id}`, { severity: 'critical', notificationsSent: [], status: 'new' });
    await hotspotEvent(cell);
    expect(pushSends).toHaveLength(1);
    expect(alertDoc(`hotspot_${cell.id}`)!.notificationsSent.length).toBeGreaterThan(0);
  });
});

describe('forecast.updated pipeline', () => {
  function seedRun(corridorId: string, aqis: number[]) {
    const id = `${corridorId}_2026-09-24T00`;
    fakeDb.collection('forecasts').seed(id, {
      id, corridorId, forecastRunTimestamp: '2026-09-24T00:00:00.000Z', keyDrivers: ['stubble fires upwind'],
      horizons: aqis.map((aqi, i) => ({
        horizonHours: [24, 48, 72][i], predictedAQI: aqi, predictedAQICategory: 'severe', predictedGRAPStage: 'none',
        confidenceInterval: { lower: aqi - 20, upper: aqi + 20 },
      })),
      modelVersion: 'rough-v0', createdAt: '2026-09-24T00:05:00.000Z',
    } as never);
    return id;
  }

  it('creates one state-level alert per corridor state; state admins (not district admins) are paged', async () => {
    const runId = seedRun('ncr-airshed', [280, 420, 390]);
    expect((await push('forecast-updated', { forecastRunId: runId, corridorId: 'ncr-airshed', maxHorizonAQI: 420 })).statusCode).toBe(204);

    const alerts = fakeDb.collection('alerts').all().map((a) => a.data as unknown as Alert);
    expect(alerts.map((a) => a.id).sort()).toEqual(['DL', 'HR', 'RJ', 'UP'].map((s) => `forecast_${runId}_${s}`));
    expect(alerts.every((a) => a.severity === 'critical' && a.impliedGrapStage === 'stage_3' && !a.assignedJurisdiction.districtCode)).toBe(true);
    expect(pushSends).toEqual([{ alertId: `forecast_${runId}_DL`, to: ['mock-iyer'] }]);
  });

  it('uses NAQI bands for a non-GRAP corridor, and creates nothing below them', async () => {
    const quiet = seedRun('mumbai-pune-corridor', [150, 180, 190]);
    await push('forecast-updated', { forecastRunId: quiet, corridorId: 'mumbai-pune-corridor', maxHorizonAQI: 190 });
    expect(fakeDb.collection('alerts').all()).toHaveLength(0);
  });
});

describe('Alerts REST (API_CONTRACTS.md §4.2)', () => {
  beforeEach(() => {
    seedAlert('a-central-new', { createdAt: '2026-09-24T03:00:00.000Z' });
    seedAlert('a-central-old', { createdAt: '2026-09-23T03:00:00.000Z', status: 'resolved' });
    seedAlert('a-north', { assignedJurisdiction: { stateCode: 'DL', districtCode: 'DL-NORTH' } });
    seedAlert('a-dl-state', { type: 'forecast', assignedJurisdiction: { stateCode: 'DL' } });
    seedAlert('a-haryana', { assignedJurisdiction: { stateCode: 'HR', districtCode: 'HR-GURUGRAM' } });
  });

  const list = async (uid: string, qs = '') => app.inject({ method: 'GET', url: `/api/v1/alerts${qs}`, headers: auth(uid) });
  const ids = (res: { json: () => { items: Alert[] } }) => res.json().items.map((a) => a.id);

  it('403s for a citizen; 401s with no token', async () => {
    expect((await list('citizen-rina')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/alerts' })).statusCode).toBe(401);
  });

  it('filters by jurisdiction server-side: district sees its district; state sees the whole state', async () => {
    expect(ids(await list('mock-deshmukh'))).toEqual(['a-central-new', 'a-central-old']);
    expect(ids(await list('mock-iyer')).sort()).toEqual(['a-central-new', 'a-central-old', 'a-dl-state', 'a-north']);
  });

  it('applies status filter, newest-first order, real totalCount and full-page-only nextPageToken', async () => {
    expect(ids(await list('mock-iyer', '?status=resolved'))).toEqual(['a-central-old']);
    const p1 = (await list('mock-iyer', '?pageSize=3')).json();
    expect(p1.totalCount).toBe(4);
    expect(p1.nextPageToken).toBeTruthy();
    const p2 = (await list('mock-iyer', `?pageSize=3&pageToken=${p1.nextPageToken}`)).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextPageToken).toBeUndefined();
  });

  it('GET /alerts/:id: 200 in jurisdiction, 403 outside, 404 missing', async () => {
    const get = (uid: string, id: string) => app.inject({ method: 'GET', url: `/api/v1/alerts/${id}`, headers: auth(uid) });
    expect((await get('mock-deshmukh', 'a-central-new')).statusCode).toBe(200);
    expect((await get('mock-deshmukh', 'a-north')).json().error.code).toBe('FORBIDDEN_JURISDICTION');
    expect((await get('mock-deshmukh', 'nope')).statusCode).toBe(404);
  });

  describe('PATCH /alerts/:id/status', () => {
    const patch = (uid: string, id: string, payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/v1/alerts/${id}/status`, headers: auth(uid), payload });

    it('appends to statusHistory (never overwrites) with the caller and note', async () => {
      const res = await patch('mock-deshmukh', 'a-central-new', { status: 'acknowledged', note: 'Team dispatched' });
      expect(res.statusCode).toBe(200);
      expect(res.json().statusHistory).toEqual([
        expect.objectContaining({ status: 'new', byUserId: 'system' }),
        expect.objectContaining({ status: 'acknowledged', byUserId: 'mock-deshmukh', note: 'Team dispatched' }),
      ]);
      expect(alertDoc('a-central-new')!.status).toBe('acknowledged');
    });

    it('409s on an invalid transition (the contract\u2019s example: resolved -> new)', async () => {
      const res = await patch('mock-deshmukh', 'a-central-old', { status: 'new' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'CONFLICT', details: { from: 'resolved', to: 'new' } });
    });

    it('treats a repeated identical status as an idempotent no-op (200, no new history)', async () => {
      await patch('mock-deshmukh', 'a-central-new', { status: 'acknowledged' });
      const again = await patch('mock-deshmukh', 'a-central-new', { status: 'acknowledged' });
      expect(again.statusCode).toBe(200);
      expect(again.json().statusHistory).toHaveLength(2);
    });

    it('400s on an unknown status; 403s outside jurisdiction', async () => {
      expect((await patch('mock-deshmukh', 'a-central-new', { status: 'closed' })).statusCode).toBe(400);
      expect((await patch('mock-deshmukh', 'a-north', { status: 'acknowledged' })).statusCode).toBe(403);
    });
  });

  it('POST /alerts/:id/assign accepts an officer covering the alert and rejects one who does not', async () => {
    const assign = (officerId: string) =>
      app.inject({ method: 'POST', url: '/api/v1/alerts/a-central-new/assign', headers: auth('mock-iyer'), payload: { officerId } });
    expect((await assign('north-officer')).statusCode).toBe(400);
    expect((await assign('no-such-user')).statusCode).toBe(400);
    const ok = await assign('mock-deshmukh');
    expect(ok.statusCode).toBe(200);
    expect(alertDoc('a-central-new')!.assignedOfficerId).toBe('mock-deshmukh');
  });
});

describe('official identity resolution', () => {
  const req = (uid: string, claims: Record<string, unknown> = {}) => ({ authUser: { uid, claims } }) as unknown as FastifyRequest;

  it('custom claims take precedence and need no users doc (ARCHITECTURE_OVERVIEW: claims drive authz)', async () => {
    await expect(requireOfficial(req('claims-only', { role: 'state_admin', stateCode: 'UP' }))).resolves.toEqual({
      uid: 'claims-only', role: 'state_admin', scope: { stateCode: 'UP' },
    });
  });

  it('a district_admin provisioned without a districtCode gets 403, never state-wide access', async () => {
    await expect(requireOfficial(req('broken', { role: 'district_admin', stateCode: 'DL' }))).rejects.toMatchObject({
      code: 'FORBIDDEN_JURISDICTION',
    });
  });
});
