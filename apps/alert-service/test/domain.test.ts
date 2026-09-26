import { describe, expect, it } from 'vitest';
import type { AlertStatus, Corridor, ForecastRun, HotspotCell } from '@vayusetu/shared-types';
import { SEVERITY_RANK, aqiToGrapStage, assessForecast, hotspotSeverity, worstHorizon } from '../src/domain/severity.js';
import { ALLOWED_TRANSITIONS, checkTransition } from '../src/domain/transitions.js';
import { AlertBriefingSchema, templateBriefingGenerator } from '../src/domain/briefing.js';

const T = { watch: 0.6, warning: 0.75, critical: 0.9 };

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
const MUMBAI: Corridor = { ...NCR, id: 'mumbai-pune-corridor', name: 'Mumbai\u2013Pune Industrial Corridor', states: ['MH'], grapFrameworkActive: false, grapThresholds: undefined };

function run(aqis: Array<[24 | 48 | 72, number]>): ForecastRun {
  return {
    id: 'ncr-airshed_2026-09-24T00',
    corridorId: 'ncr-airshed',
    forecastRunTimestamp: '2026-09-24T00:00:00.000Z',
    horizons: aqis.map(([h, aqi]) => ({
      horizonHours: h,
      predictedAQI: aqi,
      predictedAQICategory: 'very_poor',
      predictedGRAPStage: 'none',
      confidenceInterval: { lower: aqi - 30, upper: aqi + 30 },
    })),
    keyDrivers: ['low boundary-layer height'],
    modelVersion: 'rough-v0',
    createdAt: '2026-09-24T00:05:00.000Z',
  };
}

describe('severity', () => {
  it('maps hotspot scores to severities at the threshold boundaries', () => {
    expect(hotspotSeverity(0.59, T)).toBeNull();
    expect(hotspotSeverity(0.6, T)).toBe('watch');
    expect(hotspotSeverity(0.75, T)).toBe('warning');
    expect(hotspotSeverity(0.9, T)).toBe('critical');
  });

  it('SEVERITY_RANK orders by urgency -- unlike the raw string, where critical sorts last', () => {
    const bySeverityString = ['info', 'watch', 'warning', 'critical'].sort().reverse();
    expect(bySeverityString.at(-1)).toBe('critical'); // the DB_SCHEMA index bug, demonstrated
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.warning);
  });

  it('maps AQI to the highest configured GRAP stage reached', () => {
    expect(aqiToGrapStage(200, NCR.grapThresholds)).toBe('none');
    expect(aqiToGrapStage(201, NCR.grapThresholds)).toBe('stage_1');
    expect(aqiToGrapStage(420, NCR.grapThresholds)).toBe('stage_3');
    expect(aqiToGrapStage(500, NCR.grapThresholds)).toBe('stage_4');
    expect(aqiToGrapStage(480, undefined)).toBe('none'); // never invents a threshold
  });

  it('worstHorizon prefers the nearer horizon on a tie', () => {
    expect(worstHorizon(run([[72, 350], [24, 350], [48, 200]]))!.horizonHours).toBe(24);
  });

  it('GRAP corridor: stage_3 -> critical; below stage_1 -> no alert', () => {
    expect(assessForecast(run([[24, 250], [48, 420]]), NCR)).toMatchObject({ severity: 'critical', impliedGrapStage: 'stage_3' });
    expect(assessForecast(run([[24, 180]]), NCR)!.severity).toBeNull();
  });

  it('non-GRAP corridor falls back to CPCB NAQI bands and reports impliedGrapStage none', () => {
    expect(assessForecast(run([[24, 320]]), MUMBAI)).toMatchObject({ severity: 'warning', impliedGrapStage: 'none' });
  });
});

describe('status transitions', () => {
  it('rejects the contract\u2019s own example (resolved -> new) and anything out of dismissed', () => {
    expect(checkTransition('resolved', 'new')).toBe('invalid');
    expect(checkTransition('dismissed', 'in_progress')).toBe('invalid');
    expect(checkTransition('new', 'acknowledged')).toBe('ok');
    expect(checkTransition('acknowledged', 'acknowledged')).toBe('noop');
  });

  it('every next-status the dashboard UI offers is accepted by the server (no button can 409)', () => {
    // Copied from packages/ui-components/src/lib/domain.ts (Engineer 1).
    // If that map changes, update here -- this test is the contract between them.
    const ALERT_STATUS_SUGGESTED_NEXT: Record<AlertStatus, AlertStatus[]> = {
      new: ['acknowledged', 'dismissed'],
      acknowledged: ['in_progress', 'dismissed'],
      in_progress: ['resolved'],
      resolved: [],
      dismissed: [],
    };
    for (const [from, tos] of Object.entries(ALERT_STATUS_SUGGESTED_NEXT)) {
      for (const to of tos) expect(ALLOWED_TRANSITIONS[from as AlertStatus]).toContain(to);
    }
  });
});

describe('template briefing (Pipeline C stand-in)', () => {
  const cell: HotspotCell = {
    id: '881f1d4a5bfffff_2026-09-24T06',
    h3Index: '881f1d4a5bfffff',
    corridorId: 'ncr-airshed',
    timestampHour: '2026-09-24T06:00:00.000Z',
    hotspotConfidenceScore: 0.92,
    isHidden: true,
    classification: 'crop_residue_burning',
    contributingSignals: { citizenReportCount: 0, fireDetectionCount: 9, satelliteAOD: 0.58 },
    modelVersion: 'rough-v0',
    createdAt: '2026-09-24T06:05:00.000Z',
  };
  const words = (s: string) => s.trim().split(/\s+/).length;

  it('hotspot: schema-valid, title <= 12 words, cites ONLY signals present in the input', async () => {
    const b = await templateBriefingGenerator.generate({
      kind: 'hotspot',
      cell,
      corridor: NCR,
      jurisdiction: { stateCode: 'HR', districtCode: 'HR-SONIPAT' },
      severity: 'critical',
    });
    expect(AlertBriefingSchema.safeParse(b).success).toBe(true);
    expect(words(b.title)).toBeLessThanOrEqual(12);
    expect(b.citedSignals).toEqual(
      expect.arrayContaining(['contributingSignals.fireDetectionCount', 'contributingSignals.satelliteAOD', 'isHidden']),
    );
    expect(b.citedSignals).not.toContain('contributingSignals.citizenReportCount'); // it was 0
    expect(b.citedSignals).not.toContain('contributingSignals.satelliteNO2'); // absent
    expect(b.description).not.toMatch(/NO\u2082/);
    expect(b.impliedGrapStage).toBe('none');
  });

  it('forecast: schema-valid for every corridor, title <= 12 words, stage from configured thresholds', async () => {
    for (const corridor of [NCR, MUMBAI]) {
      const r = run([[24, 250], [48, 420]]);
      const a = assessForecast(r, corridor)!;
      const b = await templateBriefingGenerator.generate({
        kind: 'forecast',
        run: r,
        corridor,
        jurisdiction: { stateCode: corridor.states[0]! },
        severity: a.severity!,
        worst: a.worst,
        impliedGrapStage: a.impliedGrapStage,
      });
      expect(AlertBriefingSchema.safeParse(b).success).toBe(true);
      expect(words(b.title)).toBeLessThanOrEqual(12);
      expect(b.impliedGrapStage).toBe(corridor.grapFrameworkActive ? 'stage_3' : 'none');
      expect(b.citedSignals).toContain('horizons[1].predictedAQI');
    }
  });
});
