import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  citizenProbability,
  classify,
  fuse,
  heuristicProbability,
  hourKey,
  scoreCell,
  selectForPublication,
  toHotspotCell,
  type FeatureRow,
} from '../src/domain/fusion.js';
import { runHourly, type HourlyDeps } from '../src/domain/hourly.js';
import {
  MODEL_CATEGORICAL_FEATURES,
  MODEL_NUMERIC_FEATURES,
  heuristicScorer,
  positiveProbability,
  toInstance,
  withFallback,
} from '../src/scoring/scorers.js';

export function row(over: Partial<FeatureRow> = {}): FeatureRow {
  return {
    h3_index: '883da1ab2bfffff', corridor_id: 'ncr-airshed', ts: '2026-11-03T02:00:00.000Z',
    has_monitor_within_radius: false, nearest_station_id: 'anand-vihar', nearest_station_distance_km: 4.2,
    sat_no2: 0.00012, sat_aerosol_index: 1.1, sat_aod: 0.9, sat_fire_count: 0, sat_burn_scar: 0,
    wind_speed_ms: 1.4, wind_dir_sin: 0, wind_dir_cos: 1, temperature_c: 18, relative_humidity_pct: 70, precipitation_mm: 0,
    citizen_report_count_3h: 0, citizen_avg_severity_3h: null,
    nearest_station_aqi_d2: 380, regional_aqi_d2: 340, regional_station_count_d2: 60,
    hour_ist: 7, day_of_week: 3, month: 11, is_harvest_season: true, is_diwali_window: true,
    ...over,
  };
}

describe('fusion', () => {
  it('citizen evidence saturates', () => {
    expect(citizenProbability(0, null)).toBe(0);
    expect(citizenProbability(1, 4)).toBeCloseTo(0.37, 2);
    expect(citizenProbability(3, 4)).toBeCloseTo(0.75, 2);
    expect(citizenProbability(100, 5)).toBe(0.95);
  });

  it('fuses independent evidence', () => {
    expect(fuse(0.5, 0.5)).toBe(0.75);
    expect(fuse(0, 0.37)).toBe(0.37);
    expect(fuse(Number.NaN, 2)).toBe(1);
  });

  it('isHidden = high confidence AND no monitor within 3 km', () => {
    const opts = { hiddenMinConfidence: 0.6 };
    expect(scoreCell(row(), 0.8, 'm', opts).isHidden).toBe(true);
    expect(scoreCell(row({ has_monitor_within_radius: true }), 0.8, 'm', opts).isHidden).toBe(false);
    expect(scoreCell(row(), 0.4, 'm', opts).isHidden).toBe(false);
    // citizens can push an unmonitored cell over the line
    expect(scoreCell(row({ citizen_report_count_3h: 3, citizen_avg_severity_3h: 4 }), 0.4, 'm', opts).isHidden).toBe(true);
  });

  it('classification: citizens first, then fires', () => {
    expect(classify(row(), 'open_waste_burning')).toBe('open_waste_burning');
    expect(classify(row({ sat_fire_count: 3 }), undefined)).toBe('crop_residue_burning');
    expect(classify(row({ sat_fire_count: 3, is_harvest_season: false }), 'indeterminate')).toBe('mixed');
    expect(classify(row(), undefined)).toBe('unknown');
  });

  it('heuristic responds to the right physics', () => {
    const base = heuristicProbability(row({ is_harvest_season: false, is_diwali_window: false }));
    expect(heuristicProbability(row({ sat_fire_count: 4 }))).toBeGreaterThan(base);
    expect(heuristicProbability(row({ is_harvest_season: false, is_diwali_window: false, precipitation_mm: 10 }))).toBeLessThan(base);
    expect(heuristicProbability(row({ is_harvest_season: false, is_diwali_window: false, wind_speed_ms: 8 }))).toBeLessThan(base);
  });

  it('HotspotCell matches the contract: id format, no null/undefined optionals', () => {
    const c = toHotspotCell(scoreCell(row({ sat_no2: null }), 0.7, 'hs-v1@3', { hiddenMinConfidence: 0.6 }), 'anand-vihar', 'now');
    expect(c.id).toBe('883da1ab2bfffff_2026-11-03T02');
    expect(c.timestampHour).toBe('2026-11-03T02:00:00.000Z');
    expect('satelliteNO2' in c.contributingSignals).toBe(false);
    expect(JSON.stringify(c)).not.toContain('null');
    expect(c.contributingSignals).toMatchObject({ citizenReportCount: 0, satelliteAOD: 0.9, fireDetectionCount: 0, nearestMonitorId: 'anand-vihar' });
    expect(hourKey('2026-11-03T02:59:00Z')).toBe('2026-11-03T02');
  });

  it('publication: Firestore top-N and a per-corridor alert cap', () => {
    const cells = [0.95, 0.9, 0.7, 0.3, 0.1].map((p, i) => scoreCell(row({ h3_index: `c${i}` }), p, 'm', { hiddenMinConfidence: 0.6 }));
    const { firestore, alerts } = selectForPublication(cells, { firestoreMinScore: 0.25, firestoreMaxCells: 3, alertMinScore: 0.6, alertMaxPerCorridor: 2 });
    expect(firestore.map((c) => c.row.h3_index)).toEqual(['c0', 'c1', 'c2']);
    expect(alerts.map((c) => c.row.h3_index)).toEqual(['c0', 'c1']);
  });
});

describe('scorers', () => {
  it('model features match ml/vayusetu_ml/specs.py (train/serve parity)', () => {
    const specs = readFileSync(new URL('../../../ml/vayusetu_ml/specs.py', import.meta.url), 'utf-8');
    const block = (name: string) => specs.split(`${name}: tuple[str, ...] = (`)[1]!.split(')')[0]!;
    const list = (name: string) => [...block(name).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect([...MODEL_NUMERIC_FEATURES]).toEqual(list('numeric_features'));
    expect([...MODEL_CATEGORICAL_FEATURES]).toEqual(list('categorical_features'));
  });

  it('AutoML instance encoding: numbers, string categoricals, "" for missing', () => {
    const inst = toInstance(row({ sat_no2: null }));
    expect(inst.sat_no2).toBe('');
    expect(inst.sat_aod).toBe(0.9);
    expect(inst.hour_ist).toBe('7');
    expect(inst.is_harvest_season).toBe('true');
    expect(Object.keys(inst)).toHaveLength(MODEL_NUMERIC_FEATURES.length + MODEL_CATEGORICAL_FEATURES.length);
    expect('h3_index' in inst).toBe(false);
  });

  it('reads P(hotspot) from AutoML classification output', () => {
    expect(positiveProbability({ classes: ['normal', 'hotspot'], scores: [0.2, 0.8] })).toBe(0.8);
    expect(positiveProbability({ classes: ['normal'], scores: [1] })).toBe(0);
    expect(positiveProbability(null)).toBe(0);
  });

  it('falls back to heuristic-v0 when Vertex AI fails', async () => {
    const error = vi.fn();
    const failing = { name: 'endpoint', score: vi.fn(async () => { throw new Error('503'); }) };
    const res = await withFallback(failing, { error }).score([row()], { hourIso: 'h' });
    expect(res.modelVersion).toBe('heuristic-v0');
    expect(res.probabilities).toHaveLength(1);
    expect(error).toHaveBeenCalled();
  });
});

describe('runHourly', () => {
  function deps(rows: FeatureRow[], over: Partial<HourlyDeps> = {}) {
    const order: string[] = [];
    const d: HourlyDeps = {
      loadFeatures: vi.fn(async () => ({ rows })),
      citizenModes: vi.fn(async () => new Map([['c0', 'industrial_emission' as const]])),
      scorer: { name: 'fake', score: async (rs) => ({ probabilities: rs.map((r) => (r.h3_index === 'c0' ? 0.9 : 0.1)), modelVersion: 'hs-v1@7' }) },
      writeGrid: vi.fn(async () => { order.push('grid'); }),
      writeTopCells: vi.fn(async () => { order.push('firestore'); }),
      publishHotspotUpdated: vi.fn(async () => { order.push('publish'); }),
      now: () => new Date('2026-11-03T03:05:00Z'),
      logger: { info: () => undefined, warn: () => undefined },
      config: { hiddenMinConfidence: 0.6, firestoreMinScore: 0.25, firestoreMaxCells: 400, alertMinScore: 0.6, alertMaxPerCorridor: 25 },
      ...over,
    };
    return { d, order };
  }

  it('grid -> Firestore -> publish, in that order (alert-service re-reads the doc)', async () => {
    const { d, order } = deps([row({ h3_index: 'c0' }), row({ h3_index: 'c1' })]);
    const summary = await runHourly('2026-11-03T02:30:00Z', d);
    expect(order).toEqual(['grid', 'firestore', 'publish']);
    expect(summary).toMatchObject({ hour: '2026-11-03T02:00:00.000Z', cells: 2, hidden: 1, firestore: 1, published: 1, modelVersion: 'hs-v1@7' });
    expect(d.publishHotspotUpdated).toHaveBeenCalledWith({ hotspotCellId: 'c0_2026-11-03T02', corridorId: 'ncr-airshed', hotspotConfidenceScore: 0.9 });
    const [docs] = (d.writeTopCells as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(docs[0]).toMatchObject({ classification: 'industrial_emission', modelScore: 0.9 });
    expect(docs[0].expireAt).toBeInstanceOf(Date);
  });

  it('refuses to run on an empty grid', async () => {
    await expect(runHourly('2026-11-03T02:00:00Z', deps([]).d)).rejects.toThrow('no cells');
  });

  it('works with the bootstrap heuristic scorer', async () => {
    const { d } = deps([row()], { scorer: heuristicScorer });
    const s = await runHourly('2026-11-03T02:00:00Z', d);
    expect(s.modelVersion).toBe('heuristic-v0');
  });
});
