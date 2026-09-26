import { beforeEach, describe, expect, it } from 'vitest';
import { cellToChildren, latLngToCell } from 'h3-js';
import { runNightlySync, type SyncDeps } from '../src/jobs/nightlySync.js';
import { DEFAULT_K_OPTIONS } from '../src/lib/kAnonymize.js';
import { FakeExchange, FakeLocal, FakeRegistry, FakeState, sharedModel } from './fakes.js';

const DL_KIDS = cellToChildren(latLngToCell(28.6329, 77.2195, 6), 8);
const NOW = new Date('2026-09-23T20:30:00Z'); // Thu 02:00 IST -> last complete week starts Mon 14 Sep

let local: FakeLocal, exchange: FakeExchange, registry: FakeRegistry, state: FakeState;
const errors: string[] = [];

function deps(over: Partial<SyncDeps['cfg']> = {}): SyncDeps {
  return {
    local, exchange, registry, state,
    cfg: { stateCode: 'DL', ownedStates: ['DL', 'HR', 'UP', 'RJ'], k: DEFAULT_K_OPTIONS, ...over },
    now: () => NOW,
    logger: { info: () => {}, error: (_o, m) => errors.push(m) },
  };
}

function seedWeek(users = 12, state = 'DL') {
  local.observations = DL_KIDS.slice(0, 4).map((h3Index, i) => ({ h3Index, hotspotConfidenceScore: 0.7, modelVersion: i < 3 ? 'hs-v2' : 'hs-v1' }));
  local.contributionList = Array.from({ length: users }, (_, i) => ({ h3Index: DL_KIDS[i % DL_KIDS.length]!, userId: `u${i}`, stateCode: state }));
}

const localHotspotModel = {
  modelType: 'hotspot' as const,
  resourceName: 'projects/ncr/locations/asia-south1/models/123@4',
  version: 'v4',
  featureSchemaVersion: 'hs-v1',
  trainingDataSummary: { recordCount: 90210, dateRangeStart: '2026-06-01T00:00:00Z', dateRangeEnd: '2026-09-01T00:00:00Z' },
  performanceMetrics: { auPrc: 0.83, logLoss: 0.31 },
};

beforeEach(() => {
  local = new FakeLocal();
  exchange = new FakeExchange();
  registry = new FakeRegistry();
  state = new FakeState();
  errors.length = 0;
});

describe('runNightlySync', () => {
  it('publishes the last complete IST week, k-anonymized, stamped with the dominant model version', async () => {
    seedWeek();
    const report = await runNightlySync(deps());
    expect(report).toMatchObject({ weekStartDate: '2026-09-14', summaryRowsPublished: 1, errors: [] });
    expect(local.lastRange).toEqual({ start: new Date('2026-09-13T18:30:00Z'), end: new Date('2026-09-20T18:30:00Z') });
    expect(exchange.summary).toEqual([expect.objectContaining({ source_state_code: 'DL', model_version: 'hs-v2', week_start_date: '2026-09-14' })]);
  });

  it('is idempotent: nightly reruns in the same week never duplicate rows', async () => {
    seedWeek();
    await runNightlySync(deps());
    await runNightlySync(deps());
    expect(exchange.summary).toHaveLength(1);
  });

  it('withdraws a row that no longer qualifies on rerun (MERGE deletes within owned states + week only)', async () => {
    seedWeek();
    await runNightlySync(deps());
    exchange.summary.push({ ...exchange.summary[0]!, source_state_code: 'MH', h3_index_generalized: 'other' }); // another state's row
    seedWeek(3); // below k now
    await runNightlySync(deps());
    expect(exchange.summary.map((r) => r.source_state_code)).toEqual(['MH']); // ours withdrawn, theirs untouched
  });

  it('DEFENSE IN DEPTH: never publishes a row for a state this deployment does not own', async () => {
    seedWeek(12, 'MH');
    const report = await runNightlySync(deps());
    expect(exchange.summary).toHaveLength(0);
    expect(report.suppressed.notOwnedState).toBe(1);
  });

  it('publishes each local model version exactly once, with metrics carried in the catalog', async () => {
    registry.local.hotspot = localHotspotModel;
    await runNightlySync(deps());
    await runNightlySync(deps());
    expect(registry.exchangeCopies).toEqual(['dl-hotspot-v4']);
    expect(exchange.models.get('dl-hotspot-v4')).toMatchObject({
      source_state_code: 'DL', feature_schema_version: 'hs-v1', performance_metrics: { auPrc: 0.83, logLoss: 0.31 },
      vertex_model_registry_uri: 'projects/exchange/locations/asia-south1/models/dl-hotspot-v4',
    });
  });

  it('mirrors the full exchange catalog into local state (FederatedModel shape + downloadCount)', async () => {
    exchange.models.set('hr-hotspot-v3', sharedModel());
    exchange.imports.push({ modelId: 'hr-hotspot-v3', state: 'UP', at: 'x' });
    const report = await runNightlySync(deps());
    expect(report.modelsMirrored).toBe(1);
    expect(state.mirror.get('hr-hotspot-v3')).toMatchObject({
      id: 'hr-hotspot-v3', sourceStateCode: 'HR', downloadCount: 1, trainingDataSummary: { recordCount: 48210 },
    });
  });

  it('isolates failures: a Vertex outage still publishes the summary and mirrors, but the job fails', async () => {
    seedWeek();
    exchange.models.set('hr-hotspot-v3', sharedModel());
    registry.failNext = new Error('Vertex 503');
    const report = await runNightlySync(deps());
    expect(report.summaryRowsPublished).toBe(1);
    expect(report.modelsMirrored).toBe(1);
    expect(report.errors).toEqual(['export-model:hotspot: Vertex 503']);
  });

  it('a summary failure does not stop model publish or mirror', async () => {
    seedWeek();
    registry.local.hotspot = localHotspotModel;
    exchange.failNext.publishHotspotSummary = new Error('BigQuery 500');
    const report = await runNightlySync(deps());
    expect(report.errors).toEqual(['export-summary: BigQuery 500']);
    expect(report.modelsPublished).toEqual(['dl-hotspot-v4']);
  });

  it('no local model registered yet is not an error', async () => {
    const report = await runNightlySync(deps());
    expect(report.errors).toEqual([]);
    expect(report.modelsPublished).toEqual([]);
  });
});
