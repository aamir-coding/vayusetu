import { v1 } from '@google-cloud/aiplatform';
import type { StationPrediction } from '../domain/aggregate.js';

/** One row of core.forecast_input (BigQuery snake_case). */
export interface InputRow {
  station_id: string;
  corridor_id: string;
  ts: string;
  is_horizon: boolean;
  aqi: number | null;
  target_source: 'measured' | 'modeled' | 'horizon' | null;
  wind_speed_ms: number | null;
  wind_dir_sin: number | null;
  wind_dir_cos: number | null;
  temperature_c: number | null;
  relative_humidity_pct: number | null;
  precipitation_mm: number | null;
  day_of_week: number;
  is_harvest_season: boolean;
  is_diwali_window: boolean;
  boundary_layer_height_m: number | null;
  corridor_fire_count_d1: number | null;
  corridor_mean_aod_d1: number | null;
}

export interface ForecastResult {
  predictions: StationPrediction[];
  modelVersion: string;
}

export interface Forecaster {
  readonly name: string;
  forecast(rows: InputRow[], ctx: { runTs: Date; inputTable?: string }): Promise<ForecastResult>;
}

export const BASELINE_VERSION = 'persistence-v0';

/**
 * Bootstrap until the first AutoML Forecasting model is registered (and the
 * fallback on any Vertex failure): each station's last-24 h mean persists
 * across the horizon with a +/-25% band. Deliberately naive -- the model
 * evaluation write-up reports AutoML's skill AGAINST this baseline.
 */
export const persistenceForecaster: Forecaster = {
  name: 'persistence',
  async forecast(rows, { runTs }) {
    const t0 = runTs.getTime();
    const byStation = new Map<string, InputRow[]>();
    for (const r of rows) byStation.set(r.station_id, [...(byStation.get(r.station_id) ?? []), r]);
    const predictions: StationPrediction[] = [];
    for (const [stationId, rs] of byStation) {
      const recent = rs.filter((r) => !r.is_horizon && r.aqi != null && new Date(r.ts).getTime() >= t0 - 24 * 3_600_000);
      if (recent.length === 0) continue;
      const level = recent.reduce((s, r) => s + r.aqi!, 0) / recent.length;
      for (const r of rs.filter((x) => x.is_horizon)) {
        predictions.push({ stationId, ts: r.ts, value: level, lower: level * 0.75, upper: level * 1.25 });
      }
    }
    return { predictions, modelVersion: BASELINE_VERSION };
  },
};

/** AutoML Forecasting output struct -> value + 0.1/0.9 quantiles. */
export function parsePrediction(p: unknown): { value: number; lower?: number; upper?: number } | undefined {
  const s = p as { value?: number; quantile_values?: number[]; quantile_predictions?: number[] } | null;
  if (!s || typeof s.value !== 'number') return undefined;
  const q = (target: number) => {
    const i = s.quantile_values?.findIndex((v) => Math.abs(v - target) < 1e-6) ?? -1;
    return i >= 0 ? s.quantile_predictions?.[i] : undefined;
  };
  return { value: s.value, lower: q(0.1), upper: q(0.9) };
}

/** Vertex AI batch prediction (BigQuery -> BigQuery) on the model's `default` version. */
export function createBatchForecaster(cfg: {
  project: string;
  location: string;
  modelResource: string;
  dataset: string;
  readRows: (sql: string) => Promise<Array<Record<string, unknown>>>;
  pollMs?: number;
  timeoutMs?: number;
}): Forecaster {
  const endpoint = { apiEndpoint: `${cfg.location}-aiplatform.googleapis.com` };
  const jobs = new v1.JobServiceClient(endpoint);
  const models = new v1.ModelServiceClient(endpoint);
  return {
    name: 'batch',
    async forecast(_rows, { runTs, inputTable }) {
      if (!inputTable) throw new Error('batch forecaster needs the materialised input table');
      const [model] = await models.getModel({ name: `${cfg.modelResource}@default` });
      const versioned = `${cfg.modelResource}@${model.versionId}`;
      const [job] = await jobs.createBatchPredictionJob({
        parent: `projects/${cfg.project}/locations/${cfg.location}`,
        batchPredictionJob: {
          displayName: `forecast-${runTs.toISOString().slice(0, 13)}`,
          model: versioned,
          inputConfig: { instancesFormat: 'bigquery', bigquerySource: { inputUri: `bq://${inputTable}` } },
          outputConfig: { predictionsFormat: 'bigquery', bigqueryDestination: { outputUri: `bq://${cfg.project}.${cfg.dataset}` } },
        },
      });
      const deadline = Date.now() + (cfg.timeoutMs ?? 50 * 60_000);
      let state = job;
      while (!['JOB_STATE_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED'].includes(String(state.state))) {
        if (Date.now() > deadline) throw new Error(`batch forecast ${job.name} timed out in ${state.state}`);
        await new Promise((r) => setTimeout(r, cfg.pollMs ?? 20_000));
        [state] = await jobs.getBatchPredictionJob({ name: job.name! });
      }
      if (state.state !== 'JOB_STATE_SUCCEEDED') throw new Error(`batch forecast ${job.name} ${state.state}: ${state.error?.message}`);
      const outDataset = state.outputInfo?.bigqueryOutputDataset?.replace(/^bq:\/\//, '') ?? `${cfg.project}.${cfg.dataset}`;
      const table = `${outDataset}.${state.outputInfo?.bigqueryOutputTable}`;
      const out = await cfg.readRows(`SELECT station_id, ts, predicted_aqi FROM \`${table}\``);
      const predictions: StationPrediction[] = [];
      for (const r of out) {
        const p = parsePrediction(r.predicted_aqi);
        if (p) predictions.push({ stationId: String(r.station_id), ts: new Date(String(r.ts)).toISOString(), ...p });
      }
      if (predictions.length === 0) {
        // Keep the table for diagnosis (it expires with the dataset default); say what came back.
        throw new Error(`batch forecast ${table}: ${out.length} rows, none parsable; sample=${JSON.stringify(out.slice(0, 2))}`);
      }
      await cfg.readRows(`DROP TABLE IF EXISTS \`${table}\``);
      return { predictions, modelVersion: versioned };
    },
  };
}

/** Does every +24/+48/+72 h window [t0+h-24h, t0+h) hold at least one prediction? */
export function coversAllHorizons(predictions: StationPrediction[], runTs: Date): boolean {
  const t0 = runTs.getTime();
  return [24, 48, 72].every((h) =>
    predictions.some((p) => {
      const t = new Date(p.ts).getTime();
      return t >= t0 + (h - 24) * 3_600_000 && t < t0 + h * 3_600_000;
    }),
  );
}

/**
 * Model first; persistence-v0 if the model call throws OR returns output that
 * cannot fill all three horizons (first live model run: the batch job
 * succeeded but no prediction mapped to a horizon, so the run failed and the
 * corridor kept a stale forecast). Either way the corridor gets a forecast.
 */
export function withFallback(primary: Forecaster, log: { error(obj: object, msg: string): void }): Forecaster {
  return {
    name: `${primary.name}+fallback`,
    async forecast(rows, ctx) {
      try {
        const out = await primary.forecast(rows, ctx);
        if (coversAllHorizons(out.predictions, ctx.runTs)) return out;
        log.error(
          { forecaster: primary.name, predictions: out.predictions.length, sample: out.predictions.slice(0, 3) },
          'Model forecast does not cover all horizons; using persistence-v0 for this run',
        );
      } catch (err) {
        log.error({ err, forecaster: primary.name }, 'Model forecast failed; using persistence-v0 for this run');
      }
      return persistenceForecaster.forecast(rows, ctx);
    },
  };
}
