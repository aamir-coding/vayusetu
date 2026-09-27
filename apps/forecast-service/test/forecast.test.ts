import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Corridor } from '@vayusetu/shared-types';
import { FakeFirestore } from '@vayusetu/gcp-clients/testing';

const fakeDb = new FakeFirestore();
vi.mock('@vayusetu/gcp-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vayusetu/gcp-clients')>()),
  getDb: () => fakeDb,
  getAdminAuth: () => {
    throw new Error('AUTH_MODE=mock in tests');
  },
}));
Object.assign(process.env, { NODE_ENV: 'test', AUTH_MODE: 'mock', GOOGLE_CLOUD_PROJECT: 'vayusetu-test' });

const { aggregateHorizons, categoryForAqi, forecastRunId, grapStageFor, keyDrivers } = await import('../src/domain/aggregate.js');
const { runForecast, driverInputs } = await import('../src/domain/run.js');
const { coversAllHorizons, parsePrediction, persistenceForecaster, withFallback } = await import('../src/scoring/forecasters.js');
const { buildApp } = await import('../src/app.js');
type InputRow = import('../src/scoring/forecasters.js').InputRow;
type RunDeps = import('../src/domain/run.js').RunDeps;

const NCR: Corridor = {
  id: 'ncr-airshed', name: 'Delhi-NCR Airshed', states: ['DL', 'HR', 'UP', 'RJ'], boundaryGeoJsonStorageUrl: 'gs://x',
  population: 1, monitoringStationIds: [], grapFrameworkActive: true, createdAt: '2026-01-01T00:00:00.000Z',
  grapThresholds: { stage_1: { aqiMin: 201, aqiMax: 300 }, stage_2: { aqiMin: 301, aqiMax: 400 }, stage_3: { aqiMin: 401, aqiMax: 450 }, stage_4: { aqiMin: 451, aqiMax: 500 } },
};
const RUN = new Date('2026-11-03T00:00:00.000Z');
const hour = (h: number) => new Date(RUN.getTime() + h * 3_600_000).toISOString();

function input(station: string, contextAqi: number, over: Partial<InputRow> = {}): InputRow[] {
  const rows: InputRow[] = [];
  for (let h = -168; h < 72; h++) {
    rows.push({
      station_id: station, corridor_id: 'ncr-airshed', ts: hour(h), is_horizon: h >= 0,
      aqi: h >= 0 ? null : contextAqi, target_source: h >= 0 ? 'horizon' : h >= -48 ? 'modeled' : 'measured',
      wind_speed_ms: 1.5, wind_dir_sin: 0, wind_dir_cos: 1, temperature_c: 16, relative_humidity_pct: 85, precipitation_mm: 0,
      day_of_week: 3, is_harvest_season: true, is_diwali_window: h > 100,
      boundary_layer_height_m: h >= 0 ? null : 300, corridor_fire_count_d1: h >= 0 ? null : 140, corridor_mean_aod_d1: null, ...over,
    });
  }
  return rows;
}

describe('aggregation', () => {
  it('each horizon is the 24 h mean ending at it, averaged over stations', () => {
    const preds = [
      ...Array.from({ length: 72 }, (_, i) => ({ stationId: 'a', ts: hour(i), value: i < 24 ? 300 : i < 48 ? 360 : 460, lower: 250, upper: 500 })),
      ...Array.from({ length: 72 }, (_, i) => ({ stationId: 'b', ts: hour(i), value: i < 24 ? 200 : i < 48 ? 260 : 360 })),
    ];
    const h = aggregateHorizons(preds, RUN, NCR);
    expect(h.map((p) => p.horizonHours)).toEqual([24, 48, 72]);
    expect(h.map((p) => p.predictedAQI)).toEqual([250, 310, 410]);
    expect(h.map((p) => p.predictedGRAPStage)).toEqual(['stage_1', 'stage_2', 'stage_3']);
    expect(h[2]!.predictedAQICategory).toBe('severe');
    expect(h[0]!.confidenceInterval.lower).toBeLessThanOrEqual(h[0]!.predictedAQI);
    expect(h[0]!.confidenceInterval.upper).toBeGreaterThanOrEqual(h[0]!.predictedAQI);
  });

  it('daily model output (IST midnights of D+1..D+3) lands on +24/+48/+72 h', () => {
    // The AQI model forecasts IST calendar days (core.forecast_input): one
    // point per station per day, stamped at that day's IST midnight. The job
    // runs at :45 IST, so each day falls in exactly one [t0+h-24h, t0+h) window.
    const run = new Date('2026-11-03T06:15:00.000Z'); // 11:45 IST on D = 3 Nov
    const istMidnight = (day: number) => new Date(Date.UTC(2026, 10, day, 0, 0) - 330 * 60_000).toISOString();
    const preds = [4, 5, 6].map((day, i) => ({ stationId: 'a', ts: istMidnight(day), value: [220, 310, 405][i]! }));
    const h = aggregateHorizons(preds, run, NCR);
    expect(h.map((p) => [p.horizonHours, p.predictedAQI])).toEqual([[24, 220], [48, 310], [72, 405]]);
  });

  it('GRAP only where the corridor has an active framework; CPCB bands everywhere', () => {
    expect(grapStageFor(470, NCR)).toBe('stage_4');
    expect(grapStageFor(470, { grapFrameworkActive: false })).toBe('none');
    expect([45, 90, 150, 250, 350, 420].map(categoryForAqi)).toEqual(['good', 'satisfactory', 'moderate', 'poor', 'very_poor', 'severe']);
    expect(forecastRunId('ncr-airshed', RUN)).toBe('ncr-airshed_2026-11-03T00');
  });

  it('key drivers cite the numbers they come from, at most four', () => {
    const horizons = aggregateHorizons([{ stationId: 'a', ts: hour(60), value: 420 }, { stationId: 'a', ts: hour(10), value: 300 }, { stationId: 'a', ts: hour(30), value: 350 }], RUN, NCR);
    const drivers = keyDrivers(horizons, driverInputs(input('a', 300), RUN));
    expect(drivers[0]).toBe('AQI rising: from 300 now to 420 by +72 h');
    expect(drivers).toContain('Low forecast wind (1.5 m/s average) limits dispersion');
    expect(drivers).toContain('Punjab/Haryana crop-residue burning season');
    expect(drivers.length).toBeLessThanOrEqual(4);
  });
});

describe('forecasters', () => {
  it('persistence carries each station last-24h mean across the horizon', async () => {
    const { predictions, modelVersion } = await persistenceForecaster.forecast([...input('a', 300), ...input('b', 100)], { runTs: RUN });
    expect(modelVersion).toBe('persistence-v0');
    expect(predictions).toHaveLength(144);
    expect(predictions.find((p) => p.stationId === 'a')).toMatchObject({ value: 300, lower: 225, upper: 375 });
  });

  it('parses AutoML Forecasting quantile output', () => {
    expect(parsePrediction({ value: 310, quantile_values: [0.1, 0.5, 0.9], quantile_predictions: [250, 310, 380] })).toEqual({ value: 310, lower: 250, upper: 380 });
    expect(parsePrediction({ value: 90 })).toEqual({ value: 90, lower: undefined, upper: undefined });
    expect(parsePrediction(null)).toBeUndefined();
  });

  it('falls back to persistence on Vertex failure', async () => {
    const error = vi.fn();
    const res = await withFallback({ name: 'batch', forecast: async () => { throw new Error('quota'); } }, { error }).forecast(input('a', 200), { runTs: RUN });
    expect(res.modelVersion).toBe('persistence-v0');
    expect(error).toHaveBeenCalled();
  });

  it('falls back when the model returns output that cannot fill every horizon', async () => {
    const error = vi.fn();
    // Live incident: the batch job succeeded, but nothing mapped to a horizon.
    const offGrid = { name: 'batch', forecast: async () => ({ predictions: [{ stationId: 'a', ts: hour(-5), value: 300 }], modelVersion: 'model@1' }) };
    const res = await withFallback(offGrid, { error }).forecast(input('a', 200), { runTs: RUN });
    expect(res.modelVersion).toBe('persistence-v0');
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ predictions: 1 }), expect.stringContaining('does not cover'));
  });

  it('keeps the model output when it covers +24/+48/+72 h', async () => {
    const good = { name: 'batch', forecast: async () => ({ predictions: [10, 30, 60].map((h) => ({ stationId: 'a', ts: hour(h), value: 250 })), modelVersion: 'model@1' }) };
    expect((await withFallback(good, { error: vi.fn() }).forecast(input('a', 200), { runTs: RUN })).modelVersion).toBe('model@1');
    expect(coversAllHorizons([{ stationId: 'a', ts: hour(10), value: 1 }], RUN)).toBe(false);
  });
});

describe('runForecast', () => {
  function deps(over: Partial<RunDeps> = {}) {
    const order: string[] = [];
    const d: RunDeps = {
      corridor: async (id) => (id === 'ncr-airshed' ? NCR : undefined),
      loadInput: async () => ({ rows: [...input('a', 380), ...input('b', 420)] }),
      forecaster: persistenceForecaster,
      writeRun: vi.fn(async () => { order.push('write'); }),
      publishForecastUpdated: vi.fn(async () => { order.push('publish'); }),
      now: () => new Date('2026-11-03T00:07:00Z'),
      logger: { info: () => undefined },
      ...over,
    };
    return { d, order };
  }

  it('writes the run (with context provenance) before publishing forecast.updated', async () => {
    const { d, order } = deps();
    const run = await runForecast('ncr-airshed', RUN, d);
    expect(order).toEqual(['write', 'publish']);
    expect(run).toMatchObject({ id: 'ncr-airshed_2026-11-03T00', forecastRunTimestamp: RUN.toISOString(), modelVersion: 'persistence-v0' });
    expect(run.horizons.map((h) => h.predictedAQI)).toEqual([400, 400, 400]);
    expect((d.writeRun as ReturnType<typeof vi.fn>).mock.calls[0]![0].contextSources).toEqual({ measured: 240, modeled: 96 });
    expect(d.publishForecastUpdated).toHaveBeenCalledWith({ forecastRunId: 'ncr-airshed_2026-11-03T00', corridorId: 'ncr-airshed', maxHorizonAQI: 400 });
  });

  it('fails loudly without a corridor or any history', async () => {
    await expect(runForecast('mars', RUN, deps().d)).rejects.toThrow('not found');
    const noHistory = deps({ loadInput: async () => ({ rows: input('a', 0).map((r) => ({ ...r, aqi: null })) }) });
    await expect(runForecast('ncr-airshed', RUN, noHistory.d)).rejects.toThrow('No AQI history');
  });
});

describe('REST', () => {
  const auth = { authorization: 'Bearer mock-token:iyer' };
  const run = (ts: string, extra: object = {}) => ({
    id: `ncr-airshed_${ts.slice(0, 13)}`, corridorId: 'ncr-airshed', forecastRunTimestamp: ts, horizons: [], keyDrivers: [],
    modelVersion: 'persistence-v0', createdAt: ts, contextSources: { measured: 1, modeled: 0 }, ...extra,
  });
  beforeEach(() => {
    fakeDb.reset();
    fakeDb.collection('corridors').seed('ncr-airshed', NCR as never);
  });

  it('latest returns the newest run without internal fields', async () => {
    fakeDb.collection('forecasts').seed('r1', run('2026-11-02T18:00:00.000Z'));
    fakeDb.collection('forecasts').seed('r2', run('2026-11-03T00:00:00.000Z'));
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/v1/forecasts/ncr-airshed/latest', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('ncr-airshed_2026-11-03T00');
    expect(res.json()).not.toHaveProperty('contextSources');
  });

  it('404s for unknown corridors and corridors with no run yet; history validates range', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/forecasts/mars/latest', headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/forecasts/ncr-airshed/latest', headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/forecasts/ncr-airshed/history?range=1y', headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/forecasts/ncr-airshed/latest' })).statusCode).toBe(401);
  });

  it('history returns runs in the window, newest first', async () => {
    const now = Date.now();
    fakeDb.collection('forecasts').seed('old', run(new Date(now - 40 * 86_400_000).toISOString()));
    fakeDb.collection('forecasts').seed('new', run(new Date(now - 3_600_000).toISOString()));
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/v1/forecasts/ncr-airshed/history?range=30d', headers: auth });
    expect(res.json().runs).toHaveLength(1);
  });
});

describe('BigQuery row unwrapping', () => {
  it('unwraps BigQuery wrapper types but keeps STRUCTs that have a `value` field', async () => {
    const { isBigQueryWrapper } = await import('../src/adapters/data.js');
    // Same shape as @google-cloud/bigquery's wrapper classes.
    class BigQueryTimestamp { constructor(public value: string) {} }
    expect(isBigQueryWrapper(new BigQueryTimestamp('2026-09-27T18:30:00Z'))).toBe(true);
    // Live incident: AutoML's predicted_aqi struct was flattened to a bare number.
    const struct = { value: 85.1, quantile_values: [0.1, 0.5, 0.9], quantile_predictions: [59, 85, 121] };
    expect(isBigQueryWrapper(struct)).toBe(false);
    expect(parsePrediction(struct)).toEqual({ value: 85.1, lower: 59, upper: 121 });
  });
});
