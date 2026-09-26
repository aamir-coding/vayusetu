import { describe, expect, it, vi } from 'vitest';
import { FakeFirestore } from '@vayusetu/gcp-clients/testing';
import type { Firestore } from 'firebase-admin/firestore';
import {
  type BigQueryLike,
  type VertexModelClientLike,
  createBigQueryExchange,
  createFirestoreAdapters,
  createVertexRegistry,
  flattenMetrics,
} from '../src/lib/adapters.js';
import { exchangeModelId } from '../src/lib/ports.js';

describe('Firestore adapters', () => {
  const db = new FakeFirestore();
  const fs = createFirestoreAdapters(db as unknown as Firestore, 'DL');
  const start = new Date('2026-09-13T18:30:00Z');
  const end = new Date('2026-09-20T18:30:00Z');

  it('reads only [start, end) and skips failed / incomplete submissions', async () => {
    db.reset();
    const h = db.collection('hotspots');
    h.seed('a', { h3Index: 'x', hotspotConfidenceScore: 0.5, timestampHour: '2026-09-13T18:30:00.000Z', modelVersion: 'v1' }); // == start: in
    h.seed('b', { h3Index: 'y', hotspotConfidenceScore: 0.6, timestampHour: '2026-09-20T18:30:00.000Z' }); // == end: out
    h.seed('c', { h3Index: 'z', hotspotConfidenceScore: 0.7, timestampHour: '2026-09-10T00:00:00.000Z' }); // before: out
    expect(await fs.hotspotObservations(start, end)).toEqual([{ h3Index: 'x', hotspotConfidenceScore: 0.5, modelVersion: 'v1' }]);

    const s = db.collection('submissions');
    const at = '2026-09-15T10:00:00.000Z';
    s.seed('1', { h3Index: 'x', userId: 'u1', uploadedAt: at, status: 'analyzed', jurisdiction: { stateCode: 'DL' } });
    s.seed('2', { h3Index: 'x', userId: 'u2', uploadedAt: at, status: 'failed', jurisdiction: { stateCode: 'DL' } });
    s.seed('3', { h3Index: 'x', uploadedAt: at, status: 'queued', jurisdiction: { stateCode: 'DL' } }); // no userId
    expect(await fs.contributions(start, end)).toEqual([{ h3Index: 'x', userId: 'u1', stateCode: 'DL' }]);
  });

  it('setActive for one model type never clobbers the other type\u2019s pointer', async () => {
    db.reset();
    const a = (id: string) => ({ modelId: id, localVertexModel: `m/${id}`, activatedAt: 't', activatedBy: 'root' });
    await fs.setActive('hotspot', a('h1'));
    await fs.setActive('forecast', a('f1'));
    expect(await fs.getActive('hotspot')).toMatchObject({ modelId: 'h1' });
    expect(await fs.getActive('forecast')).toMatchObject({ modelId: 'f1' });
  });
});

describe('BigQuery exchange adapter', () => {
  function capture(rows: unknown[] = []) {
    const calls: Array<Parameters<BigQueryLike['query']>[0]> = [];
    const bq: BigQueryLike = { query: vi.fn(async (o) => { calls.push(o); return [rows] as [unknown[]]; }) };
    return { calls, ex: createBigQueryExchange(bq, { project: 'exch', dataset: 'federation_exchange', location: 'asia-south1' }) };
  }

  it('publishes via ONE atomic MERGE scoped to owned states + week, typed so an empty week still withdraws rows', async () => {
    const { calls, ex } = capture();
    await ex.publishHotspotSummary([], '2026-09-14', ['DL', 'HR']);
    const q = calls[0]!;
    expect(q.query).toMatch(/^MERGE `exch\.federation_exchange\.hotspot_summary`/);
    expect(q.query).toContain('WHEN NOT MATCHED BY SOURCE');
    expect(q.query).toContain('T.source_state_code IN UNNEST(@states)');
    expect(q.params).toEqual({ rows: [], week: '2026-09-14', states: ['DL', 'HR'] });
    expect(q.types).toMatchObject({ rows: [expect.objectContaining({ h3_index_generalized: 'STRING' })], states: ['STRING'] });
    expect(q.location).toBe('asia-south1');
  });

  it('parses the catalog: JSON metrics, numeric download counts', async () => {
    const { ex } = capture([{ model_id: 'hr-hotspot-v3', model_type: 'hotspot', performance_metrics: '{"auPrc":0.81}', download_count: '2', training_record_count: '100' }]);
    expect(await ex.getSharedModel('hr-hotspot-v3')).toMatchObject({ performance_metrics: { auPrc: 0.81 }, download_count: 2, training_record_count: 100 });
  });

  it('inserts catalog rows with MERGE on model_id (republishing is a no-op)', async () => {
    const { calls, ex } = capture();
    await ex.insertSharedModel({
      model_id: 'dl-hotspot-v4', source_state_code: 'DL', model_type: 'hotspot', version: 'v4', feature_schema_version: 'hs-v1',
      vertex_model_registry_uri: 'u', training_record_count: 1, training_date_range_start: 'a', training_date_range_end: 'b',
      performance_metrics: { auPrc: 0.8 }, shared_at: 'c',
    });
    expect(calls[0]!.query).toMatch(/MERGE `exch\.federation_exchange\.shared_models`[\s\S]*WHEN NOT MATCHED THEN INSERT/);
    expect((calls[0]!.params as Record<string, unknown>).performance_metrics).toBe('{"auPrc":0.8}');
  });
});

describe('Vertex registry adapter', () => {
  const model = { name: 'projects/ncr/locations/asia-south1/models/123', versionId: '4', labels: { 'vayusetu-model-type': 'hotspot', 'vayusetu-feature-schema': 'hs-v1', 'vayusetu-train-rows': '90210', 'vayusetu-train-start': '2026-06-01' } };
  // Evaluation metrics as the GAPIC client returns them: a protobuf Value tree.
  const protoMetrics = { structValue: { fields: { auPrc: { numberValue: 0.83 }, confusionMatrix: { structValue: { fields: { rows: { listValue: {} } } } }, logLoss: { numberValue: 0.31 } } } };

  function client(over: Partial<VertexModelClientLike> = {}): VertexModelClientLike & { copies: unknown[] } {
    const copies: unknown[] = [];
    return {
      copies,
      listModels: vi.fn(async () => [[{ name: model.name }]] as never),
      getModel: vi.fn(async () => [model] as never),
      listModelEvaluations: vi.fn(async () => [[{ metrics: protoMetrics }]] as never),
      copyModel: vi.fn(async (req) => {
        copies.push(req);
        return [{ promise: async () => [{ model: 'projects/exch/locations/asia-south1/models/dl-hotspot-v4', modelVersionId: '1' }] }]as never;
      }),
      ...over,
    };
  }
  const cfg = { localProject: 'ncr', exchangeProject: 'exch', location: 'asia-south1' };

  it('reads the default version by label, with flattened numeric metrics and training summary', async () => {
    const c = client();
    const m = await createVertexRegistry(c, cfg).localDefaultModel('hotspot');
    expect(c.listModels).toHaveBeenCalledWith({ parent: 'projects/ncr/locations/asia-south1', filter: 'labels.vayusetu-model-type="hotspot"' });
    expect(m).toMatchObject({
      resourceName: `${model.name}@4`, version: 'v4', featureSchemaVersion: 'hs-v1',
      trainingDataSummary: { recordCount: 90210, dateRangeStart: '2026-06-01T00:00:00Z' },
      performanceMetrics: { auPrc: 0.83, logLoss: 0.31 },
    });
  });

  it('copies cross-project into the EXCHANGE, and resumes on ALREADY_EXISTS (copy done, catalog write lost)', async () => {
    const c = client();
    const reg = createVertexRegistry(c, cfg);
    const local = (await reg.localDefaultModel('hotspot'))!;
    await reg.copyToExchange(local, 'dl-hotspot-v4');
    expect(c.copies[0]).toEqual({ parent: 'projects/exch/locations/asia-south1', sourceModel: `${model.name}@4`, modelId: 'dl-hotspot-v4' });

    const dup = client({ copyModel: vi.fn(async () => { throw Object.assign(new Error('exists'), { code: 6 }); }) });
    expect(await createVertexRegistry(dup, cfg).copyToExchange(local, 'dl-hotspot-v4')).toBe('projects/exch/locations/asia-south1/models/dl-hotspot-v4');
  });

  it('other copy errors propagate (the job reports them)', async () => {
    const bad = client({ copyModel: vi.fn(async () => { throw Object.assign(new Error('denied'), { code: 7 }); }) });
    await expect(createVertexRegistry(bad, cfg).importFromExchange('x', 'y')).rejects.toThrow('denied');
  });

  it('returns null when Engineer 3 has not registered a model of that type', async () => {
    expect(await createVertexRegistry(client({ listModels: vi.fn(async () => [[]] as never) }), cfg).localDefaultModel('forecast')).toBeNull();
  });
});

describe('helpers', () => {
  it('flattenMetrics handles proto Values and plain objects, ignoring non-numeric leaves', () => {
    expect(flattenMetrics({ a: 1, b: { c: 2, d: 'x' } })).toEqual({ a: 1, 'b.c': 2 });
    expect(flattenMetrics(null)).toEqual({});
  });

  it('exchangeModelId is registry-safe: lowercase, [a-z0-9_-], <= 63 chars, starts with a letter', () => {
    expect(exchangeModelId('DL', 'hotspot', 'v4')).toBe('dl-hotspot-v4');
    const long = exchangeModelId('DL', 'forecast', `v${'9'.repeat(80)}.RC/1`);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z][a-z0-9_-]*[a-z0-9_]$/);
  });
});
