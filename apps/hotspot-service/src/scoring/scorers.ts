import { helpers, v1 } from '@google-cloud/aiplatform';
import { heuristicProbability, type FeatureRow } from '../domain/fusion.js';

export interface ModelScores {
  /** P(hotspot) per input row, same order. */
  probabilities: number[];
  modelVersion: string;
}

export interface ModelScorer {
  readonly name: string;
  score(rows: FeatureRow[], context: { hourIso: string; inputTable?: string }): Promise<ModelScores>;
}

export const HEURISTIC_VERSION = 'heuristic-v0';

export const heuristicScorer: ModelScorer = {
  name: 'heuristic',
  async score(rows) {
    return { probabilities: rows.map(heuristicProbability), modelVersion: HEURISTIC_VERSION };
  },
};

/** Feature names + types come from ml/vayusetu_ml/specs.py (keep in sync; a test checks). */
export const MODEL_NUMERIC_FEATURES = [
  'sat_no2', 'sat_aerosol_index', 'sat_aod', 'sat_fire_count', 'sat_burn_scar',
  'wind_speed_ms', 'wind_dir_sin', 'wind_dir_cos', 'temperature_c', 'relative_humidity_pct', 'precipitation_mm',
  'citizen_report_count_3h', 'citizen_avg_severity_3h',
  'regional_aqi_d2', 'regional_station_count_d2',
] as const;
export const MODEL_CATEGORICAL_FEATURES = ['hour_ist', 'day_of_week', 'month', 'is_harvest_season', 'is_diwali_window'] as const;
export const POSITIVE_CLASS = 'hotspot';

/**
 * AutoML Tabular online instance: numbers as numbers, categoricals as
 * strings, missing values as "" (AutoML's documented "missing" encoding).
 */
export function toInstance(r: FeatureRow): Record<string, string | number> {
  const inst: Record<string, string | number> = {};
  for (const f of MODEL_NUMERIC_FEATURES) {
    const v = r[f];
    inst[f] = v == null ? '' : Number(v);
  }
  for (const f of MODEL_CATEGORICAL_FEATURES) {
    const v = r[f];
    inst[f] = v == null ? '' : String(v);
  }
  return inst;
}

/** AutoML classification output -> P(positive class). */
export function positiveProbability(prediction: unknown): number {
  const p = prediction as { classes?: string[]; scores?: number[] } | null;
  const i = p?.classes?.indexOf(POSITIVE_CLASS) ?? -1;
  const s = i >= 0 ? p?.scores?.[i] : undefined;
  return typeof s === 'number' && Number.isFinite(s) ? s : 0;
}

/**
 * Online prediction against a Vertex AI endpoint serving the AutoML Tabular
 * model (lowest latency; costs an always-on node while deployed).
 */
export function createEndpointScorer(cfg: { project: string; location: string; endpointId: string; batchSize?: number }): ModelScorer {
  const client = new v1.PredictionServiceClient({ apiEndpoint: `${cfg.location}-aiplatform.googleapis.com` });
  const endpoint = `projects/${cfg.project}/locations/${cfg.location}/endpoints/${cfg.endpointId}`;
  const batchSize = cfg.batchSize ?? 500;
  return {
    name: 'endpoint',
    async score(rows) {
      const probabilities: number[] = [];
      let modelVersion = `endpoint:${cfg.endpointId}`;
      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const [res] = await client.predict({
          endpoint,
          instances: chunk.map((r) => helpers.toValue(toInstance(r))!),
        });
        if (res.deployedModelId) modelVersion = `${res.model ?? 'model'}@${res.modelVersionId ?? res.deployedModelId}`;
        for (const p of res.predictions ?? []) probabilities.push(positiveProbability(helpers.fromValue(p as never)));
      }
      if (probabilities.length !== rows.length) throw new Error(`endpoint returned ${probabilities.length}/${rows.length} predictions`);
      return { probabilities, modelVersion };
    },
  };
}

/**
 * Batch prediction BigQuery -> BigQuery on the registry model's `default`
 * version (pay per job, no always-on node). The input table is the features
 * table the job already materialised for this hour.
 */
export function createBatchScorer(cfg: {
  project: string;
  location: string;
  modelResource: string; // projects/<p>/locations/<l>/models/<id>
  dataset: string;
  readRows: (sql: string) => Promise<Array<Record<string, unknown>>>;
  pollMs?: number;
  timeoutMs?: number;
}): ModelScorer {
  const jobs = new v1.JobServiceClient({ apiEndpoint: `${cfg.location}-aiplatform.googleapis.com` });
  const models = new v1.ModelServiceClient({ apiEndpoint: `${cfg.location}-aiplatform.googleapis.com` });
  return {
    name: 'batch',
    async score(rows, context) {
      if (!context.inputTable) throw new Error('batch scorer needs the materialised input table');
      const [model] = await models.getModel({ name: `${cfg.modelResource}@default` });
      const versioned = `${cfg.modelResource}@${model.versionId}`;
      const [job] = await jobs.createBatchPredictionJob({
        parent: `projects/${cfg.project}/locations/${cfg.location}`,
        batchPredictionJob: {
          displayName: `hotspot-${context.hourIso.slice(0, 13)}`,
          model: versioned,
          inputConfig: { instancesFormat: 'bigquery', bigquerySource: { inputUri: `bq://${context.inputTable}` } },
          outputConfig: { predictionsFormat: 'bigquery', bigqueryDestination: { outputUri: `bq://${cfg.project}.${cfg.dataset}` } },
        },
      });
      const deadline = Date.now() + (cfg.timeoutMs ?? 50 * 60_000);
      let state = job;
      while (!['JOB_STATE_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED'].includes(String(state.state))) {
        if (Date.now() > deadline) throw new Error(`batch prediction ${job.name} timed out in ${state.state}`);
        await new Promise((r) => setTimeout(r, cfg.pollMs ?? 20_000));
        [state] = await jobs.getBatchPredictionJob({ name: job.name! });
      }
      if (state.state !== 'JOB_STATE_SUCCEEDED') throw new Error(`batch prediction ${job.name} ${state.state}: ${state.error?.message}`);
      const out = state.outputInfo?.bigqueryOutputTable;
      const outDataset = state.outputInfo?.bigqueryOutputDataset?.replace(/^bq:\/\//, '') ?? `${cfg.project}.${cfg.dataset}`;
      const table = `${outDataset}.${out}`;
      const results = await cfg.readRows(`SELECT h3_index, predicted_is_hotspot FROM \`${table}\``);
      const byCell = new Map(results.map((r) => [String(r.h3_index), positiveProbability(r.predicted_is_hotspot)]));
      await cfg.readRows(`DROP TABLE IF EXISTS \`${table}\``);
      return { probabilities: rows.map((r) => byCell.get(r.h3_index) ?? 0), modelVersion: versioned };
    },
  };
}

/** Try the model; on any failure fall back to the heuristic so the hourly grid never goes dark. */
export function withFallback(
  primary: ModelScorer,
  log: { error(obj: object, msg: string): void },
): ModelScorer {
  return {
    name: `${primary.name}+fallback`,
    async score(rows, ctx) {
      try {
        return await primary.score(rows, ctx);
      } catch (err) {
        log.error({ err, scorer: primary.name }, 'Model scoring failed; using heuristic-v0 for this hour');
        return heuristicScorer.score(rows, ctx);
      }
    },
  };
}
