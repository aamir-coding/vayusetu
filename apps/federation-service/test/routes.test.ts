import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { latLngToCell } from 'h3-js';
import { FakeFirestore } from '@vayusetu/gcp-clients/testing';
import { FakeExchange, FakeRegistry, FakeState, sharedModel } from './fakes.js';
import { toFederatedModel } from '../src/lib/ports.js';

const fakeDb = new FakeFirestore();
vi.mock('@vayusetu/gcp-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vayusetu/gcp-clients')>()),
  getDb: () => fakeDb,
  getAdminAuth: () => {
    throw new Error('getAdminAuth() must not be called in AUTH_MODE=mock');
  },
}));

Object.assign(process.env, {
  AUTH_MODE: 'mock', NODE_ENV: 'test', GOOGLE_CLOUD_PROJECT: 'vayusetu-test',
  FEDERATION_STATE_CODE: 'DL', FEDERATION_OWNED_STATES: 'DL,HR,UP,RJ', EXCHANGE_PROJECT_ID: 'exchange-test',
  FEATURE_SCHEMA_VERSIONS: 'hotspot=hs-v1,forecast=fc-v1', SUMMARY_LOOKBACK_WEEKS: '2', IMPORT_TIMEOUT_MS: '1000',
});
const { buildApp } = await import('../src/app.js');

const NOW = new Date('2026-09-23T10:00:00Z'); // latest complete week: 2026-09-14
const auth = (uid: string) => ({ authorization: `Bearer mock-token:${uid}` });

let app: FastifyInstance, exchange: FakeExchange, registry: FakeRegistry, state: FakeState;

function official(uid: string, role: string, jurisdiction?: object) {
  fakeDb.collection('users').seed(uid, { uid, role, displayName: uid, preferredLanguage: 'en-IN', fcmTokens: [], ...(jurisdiction ? { jurisdiction } : {}) });
}

beforeEach(async () => {
  fakeDb.reset();
  official('mock-iyer', 'state_admin', { stateCode: 'DL' });
  official('mock-deshmukh', 'district_admin', { stateCode: 'DL', districtCode: 'DL-CENTRAL' });
  official('root', 'super_admin');
  exchange = new FakeExchange();
  registry = new FakeRegistry();
  state = new FakeState();
  const hr = sharedModel();
  const ownDl = sharedModel({ model_id: 'dl-hotspot-v4', source_state_code: 'DL', version: 'v4', shared_at: '2026-09-21T01:00:00Z' });
  const upForecast = sharedModel({ model_id: 'up-forecast-v1', source_state_code: 'UP', model_type: 'forecast', feature_schema_version: 'fc-v1' });
  const incompatible = sharedModel({ model_id: 'mh-hotspot-v9', source_state_code: 'MH', feature_schema_version: 'hs-v2' });
  for (const m of [hr, ownDl, upForecast, incompatible]) exchange.models.set(m.model_id, m);
  await state.mirrorSharedModels([...exchange.models.values()].map((m) => toFederatedModel({ ...m, download_count: 0 })));
  app = await buildApp({ deps: { exchange, registry, state }, now: () => NOW });
});
afterEach(async () => app.close());

describe('auth (contract: state_admin+ for reads, super_admin only for import)', () => {
  it('401 without a token; 403 for district_admin on every endpoint', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/federation/models' })).statusCode).toBe(401);
    for (const [method, url] of [['GET', '/api/v1/federation/models'], ['GET', '/api/v1/federation/exchange/hotspot-summary'], ['POST', '/api/v1/federation/models/hr-hotspot-v3/import']] as const) {
      const res = await app.inject({ method, url, headers: auth('mock-deshmukh') });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN_JURISDICTION');
    }
  });

  it('a state_admin cannot import (the highest-blast-radius action)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/federation/models/hr-hotspot-v3/import', headers: auth('mock-iyer') });
    expect(res.statusCode).toBe(403);
    expect(registry.localImports).toHaveLength(0);
  });
});

describe('GET /federation/models', () => {
  it('lists other states\u2019 models (never our own), contract-shaped, and our own latest as currentlyActive', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/v1/federation/models?type=hotspot', headers: auth('mock-iyer') })).json();
    expect(body.available.map((m: { id: string }) => m.id).sort()).toEqual(['hr-hotspot-v3', 'mh-hotspot-v9']);
    expect(body.available[0]).not.toHaveProperty('featureSchemaVersion'); // internal field stripped
    expect(Object.keys(body.available[0]).sort()).toEqual(
      ['downloadCount', 'id', 'modelType', 'performanceMetrics', 'sharedAt', 'sourceStateCode', 'trainingDataSummary', 'vertexModelRegistryUri', 'version'].sort(),
    );
    expect(body.currentlyActive.id).toBe('dl-hotspot-v4');
  });

  it('without ?type= returns both types and currentlyActive null', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/v1/federation/models', headers: auth('mock-iyer') })).json();
    expect(body.available).toHaveLength(3);
    expect(body.currentlyActive).toBeNull();
  });
});

describe('POST /federation/models/:modelId/import', () => {
  const importAs = (uid: string, id: string) => app.inject({ method: 'POST', url: `/api/v1/federation/models/${id}/import`, headers: auth(uid) });

  it('copies the model into this project, activates it, counts the download, and flips currentlyActive', async () => {
    const res = await importAs('root', 'hr-hotspot-v3');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ imported: { id: 'hr-hotspot-v3', downloadCount: 1 }, activatedAt: NOW.toISOString() });
    expect(registry.localImports).toEqual(['projects/exchange/locations/asia-south1/models/hr-hotspot-v3']);
    expect(state.active.hotspot).toMatchObject({ modelId: 'hr-hotspot-v3', activatedBy: 'root', localVertexModel: expect.stringContaining('imported-hr-hotspot-v3') });
    const list = (await app.inject({ method: 'GET', url: '/api/v1/federation/models?type=hotspot', headers: auth('mock-iyer') })).json();
    expect(list.currentlyActive.id).toBe('hr-hotspot-v3');
  });

  it('is idempotent: re-importing the active model does not copy again', async () => {
    await importAs('root', 'hr-hotspot-v3');
    const again = await importAs('root', 'hr-hotspot-v3');
    expect(again.statusCode).toBe(200);
    expect(registry.localImports).toHaveLength(1);
    expect(exchange.imports).toHaveLength(1);
  });

  it('409 on an incompatible feature schema, with both versions in details', async () => {
    const res = await importAs('root', 'mh-hotspot-v9');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CONFLICT', details: { modelFeatureSchema: 'hs-v2', deploymentFeatureSchema: 'hs-v1' } });
    expect(registry.localImports).toHaveLength(0);
  });

  it('404 for an unknown id, and for our own state\u2019s model (not importable)', async () => {
    expect((await importAs('root', 'nope')).statusCode).toBe(404);
    expect((await importAs('root', 'dl-hotspot-v4')).statusCode).toBe(404);
  });

  it('a slow copy returns 500 "retry" WITHOUT activating anything', async () => {
    registry.importDelayMs = 1500;
    const res = await importAs('root', 'hr-hotspot-v3');
    expect(res.statusCode).toBe(500);
    expect(state.active.hotspot).toBeUndefined();
  });

  it('a failure to record the download never blocks activation', async () => {
    exchange.failNext.recordImport = new Error('BigQuery 500');
    const res = await importAs('root', 'up-forecast-v1');
    expect(res.statusCode).toBe(200);
    expect(state.active.forecast?.modelId).toBe('up-forecast-v1');
  });
});

describe('GET /federation/exchange/hotspot-summary', () => {
  const hrCell = latLngToCell(28.4595, 77.0266, 6); // Gurugram
  const upCell = latLngToCell(28.6692, 77.4538, 6); // Ghaziabad
  const mhCell = latLngToCell(19.076, 72.8777, 6); // Mumbai
  const row = (state: string, cell: string, week: string) => ({
    source_state_code: state, h3_index_generalized: cell, week_start_date: week, avg_hotspot_confidence: 0.68,
    underlying_report_count_bucket: '10-50' as const, model_version: 'hs-v3', shared_at: '2026-09-21T01:00:00Z',
  });
  beforeEach(() => {
    exchange.summary = [row('HR', hrCell, '2026-09-14'), row('UP', upCell, '2026-09-07'), row('MH', mhCell, '2026-09-14'), row('HR', hrCell, '2026-08-31')];
  });
  const get = (qs = '') => app.inject({ method: 'GET', url: `/api/v1/federation/exchange/hotspot-summary${qs}`, headers: auth('mock-iyer') });

  it('returns the contract shape for the lookback window only (2 weeks here)', async () => {
    const body = (await get()).json();
    expect(body.summary).toHaveLength(3); // the 2026-08-31 row is outside the window
    expect(Object.keys(body.summary[0]).sort()).toEqual(['avgHotspotConfidence', 'h3IndexGeneralized', 'sourceStateCode', 'weekStartDate']);
  });

  it('clips to the bbox by cell centre (NCR box excludes Mumbai)', async () => {
    const body = (await get('?bbox=28.0,76.5,29.2,78.0')).json();
    expect(body.summary.map((s: { sourceStateCode: string }) => s.sourceStateCode).sort()).toEqual(['HR', 'UP']);
  });

  it('400 on a malformed or inverted bbox', async () => {
    for (const bad of ['?bbox=1,2,3', '?bbox=a,b,c,d', '?bbox=29,77,28,78']) expect((await get(bad)).statusCode, bad).toBe(400);
  });
});
