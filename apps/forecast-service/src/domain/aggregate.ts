import type { AQICategory, Corridor, ForecastHorizonPoint, GRAPStage } from '@vayusetu/shared-types';

/**
 * Station-level hourly predictions -> the corridor's 24/48/72 h ForecastRun
 * (PRODUCT_SPEC Feature 3). Pure functions.
 *
 * Horizon value = the mean over the 24 h window ENDING at that horizon
 * (CPCB NAQI is itself a 24-hour-average index), averaged across the
 * corridor's monitors (how Delhi's city AQI is reported).
 */

export interface StationPrediction {
  stationId: string;
  ts: string; // hour the prediction is for
  value: number;
  lower?: number; // quantile 0.1
  upper?: number; // quantile 0.9
}

/** Hourly covariates over the horizon + recent context, for keyDrivers. */
export interface DriverInputs {
  currentAqi?: number; // mean of the last 24 h of context
  meanWindSpeedMs?: number;
  meanHumidityPct?: number;
  harvestSeason: boolean;
  diwaliWindow: boolean;
  firesYesterday?: number;
  month: number; // IST month of the run
}

export const HORIZONS = [24, 48, 72] as const;

export function categoryForAqi(aqi: number): AQICategory {
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'satisfactory';
  if (aqi <= 200) return 'moderate';
  if (aqi <= 300) return 'poor';
  if (aqi <= 400) return 'very_poor';
  return 'severe';
}

/** Same rule as alert-service: highest configured stage whose lower bound the AQI reaches. */
export function grapStageFor(aqi: number, corridor: Pick<Corridor, 'grapFrameworkActive' | 'grapThresholds'>): GRAPStage {
  const t = corridor.grapThresholds;
  if (!corridor.grapFrameworkActive || !t) return 'none';
  for (const stage of ['stage_4', 'stage_3', 'stage_2', 'stage_1'] as const) {
    if (t[stage] && aqi >= t[stage].aqiMin) return stage;
  }
  return 'none';
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (x: number) => Math.round(x);

export function aggregateHorizons(
  predictions: StationPrediction[],
  runTs: Date,
  corridor: Pick<Corridor, 'grapFrameworkActive' | 'grapThresholds'>,
): ForecastHorizonPoint[] {
  const t0 = runTs.getTime();
  const points: ForecastHorizonPoint[] = [];
  for (const h of HORIZONS) {
    const from = t0 + (h - 24) * 3_600_000;
    const to = t0 + h * 3_600_000;
    const byStation = new Map<string, StationPrediction[]>();
    for (const p of predictions) {
      const t = new Date(p.ts).getTime();
      if (t >= from && t < to) byStation.set(p.stationId, [...(byStation.get(p.stationId) ?? []), p]);
    }
    if (byStation.size === 0) continue;
    const perStation = [...byStation.values()].map((ps) => ({
      value: mean(ps.map((p) => p.value)),
      lower: mean(ps.map((p) => p.lower ?? p.value)),
      upper: mean(ps.map((p) => p.upper ?? p.value)),
    }));
    const value = Math.max(0, round(mean(perStation.map((s) => s.value))));
    const lower = Math.max(0, round(Math.min(value, mean(perStation.map((s) => s.lower)))));
    const upper = Math.max(value, round(mean(perStation.map((s) => s.upper))));
    points.push({
      horizonHours: h,
      predictedAQI: value,
      predictedAQICategory: categoryForAqi(value),
      predictedGRAPStage: grapStageFor(value, corridor),
      confidenceInterval: { lower, upper },
    });
  }
  return points;
}

/** Plain-language, data-grounded drivers (each cites a number that was actually used). */
export function keyDrivers(horizons: ForecastHorizonPoint[], d: DriverInputs): string[] {
  const out: string[] = [];
  const last = horizons.at(-1);
  if (d.currentAqi !== undefined && last) {
    const delta = last.predictedAQI - d.currentAqi;
    if (delta >= 50) out.push(`AQI rising: from ${round(d.currentAqi)} now to ${last.predictedAQI} by +${last.horizonHours} h`);
    else if (delta <= -50) out.push(`AQI easing: from ${round(d.currentAqi)} now to ${last.predictedAQI} by +${last.horizonHours} h`);
  }
  if (d.meanWindSpeedMs !== undefined && d.meanWindSpeedMs < 2.5) {
    out.push(`Low forecast wind (${d.meanWindSpeedMs.toFixed(1)} m/s average) limits dispersion`);
  }
  if (d.harvestSeason) out.push('Punjab/Haryana crop-residue burning season');
  if (d.firesYesterday !== undefined && d.firesYesterday >= 10) out.push(`${d.firesYesterday} satellite fire detections in the corridor yesterday`);
  if (d.diwaliWindow) out.push('Diwali festival window (firecracker emissions)');
  if (d.meanHumidityPct !== undefined && d.meanHumidityPct >= 80 && [11, 12, 1, 2].includes(d.month)) {
    out.push(`High humidity (${round(d.meanHumidityPct)}%) with winter inversion favours fog and secondary particles`);
  }
  return out.slice(0, 4);
}

/** `${corridorId}_${YYYY-MM-DDTHH}` -- the id alert-service and the dashboard use. */
export function forecastRunId(corridorId: string, runTs: Date): string {
  return `${corridorId}_${runTs.toISOString().slice(0, 13)}`;
}
