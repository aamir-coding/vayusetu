import { getBigQuery, getDb } from '@vayusetu/gcp-clients';
import type { Corridor, ForecastRun } from '@vayusetu/shared-types';
import type { InputRow } from '../scoring/forecasters.js';

/**
 * The BigQuery client wraps TIMESTAMP/DATE/DATETIME/TIME/NUMERIC as
 * BigQuery{Timestamp,Date,...} objects with a `.value`. Unwrap ONLY those:
 * a STRUCT that happens to have a `value` field (AutoML Forecasting's
 * predicted_aqi {value, quantile_values, quantile_predictions}) must stay
 * intact -- flattening it lost every live model prediction ("covered 0/3").
 */
export function isBigQueryWrapper(v: unknown): v is { value: unknown } {
  return Boolean(v) && typeof v === 'object' && 'value' in (v as object) && /^Big/.test((v as object).constructor?.name ?? '');
}

function plain(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = isBigQueryWrapper(v) ? v.value : v;
  }
  return out;
}

type LoadableTable = {
  createWriteStream(metadata: object): NodeJS.WritableStream & { on(event: string, cb: (arg: unknown) => void): unknown };
};

/** NDJSON load job (not streaming inserts: streamed rows can't be DELETEd for ~90 min). */
export function loadJson(table: LoadableTable, rows: object[]): Promise<void> {
  if (rows.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stream = table.createWriteStream({ sourceFormat: 'NEWLINE_DELIMITED_JSON', writeDisposition: 'WRITE_APPEND' });
    stream.on('error', (err) => reject(err as Error));
    stream.on('complete', (job) => {
      const status = (job as { metadata?: { status?: { errorResult?: { message?: string } } } }).metadata?.status;
      if (status?.errorResult) reject(new Error(`BigQuery load failed: ${status.errorResult.message}`));
      else resolve();
    });
    stream.end(rows.map((r) => JSON.stringify(r)).join('\n'));
  });
}

export function createDataAdapters(cfg: { project: string; dataset: string; location: string }) {
  const t = (name: string) => `\`${cfg.project}.${cfg.dataset}.${name}\``;
  const query = async (sql: string, params?: Record<string, unknown>) => {
    const [rows] = await getBigQuery().query({ query: sql, params, location: cfg.location });
    return (rows as Array<Record<string, unknown>>).map(plain);
  };

  return {
    query,

    async corridor(corridorId: string): Promise<Corridor | undefined> {
      const snap = await getDb().collection('corridors').doc(corridorId).get();
      return snap.exists ? (snap.data() as Corridor) : undefined;
    },

    async loadInput(runTs: Date, corridorId: string): Promise<{ rows: InputRow[]; inputTable: string }> {
      const params = { run: runTs.toISOString(), corridor: corridorId };
      const inputTable = `${cfg.project}.${cfg.dataset}.forecast_scoring_input_${corridorId.replace(/-/g, '_')}`;
      // Exactly the training columns (minus split): AutoML batch prediction
      // matches input columns to the training schema.
      await query(
        `CREATE OR REPLACE TABLE \`${inputTable}\`
         OPTIONS (expiration_timestamp = TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)) AS
         SELECT * EXCEPT (is_horizon, target_source) FROM ${t('forecast_input')}(TIMESTAMP(@run), @corridor)`,
        params,
      );
      const rows = (await query(`SELECT * FROM ${t('forecast_input')}(TIMESTAMP(@run), @corridor) ORDER BY station_id, ts`, params)).map(
        (r) => ({ ...r, ts: new Date(String(r.ts)).toISOString() }),
      ) as unknown as InputRow[];
      return { rows, inputTable };
    },

    async writeRun(run: ForecastRun & { contextSources: { measured: number; modeled: number } }): Promise<void> {
      await getDb().collection('forecasts').doc(run.id).set(run);
      await query(`DELETE FROM ${t('forecast_runs')} WHERE id = @id`, { id: run.id });
      await loadJson(
        getBigQuery().dataset(cfg.dataset).table('forecast_runs'),
        run.horizons.map((h) => ({
          id: run.id,
          corridor_id: run.corridorId,
          forecast_run_timestamp: run.forecastRunTimestamp,
          horizon_hours: h.horizonHours,
          predicted_aqi: h.predictedAQI,
          predicted_aqi_category: h.predictedAQICategory,
          predicted_grap_stage: h.predictedGRAPStage,
          ci_lower: h.confidenceInterval.lower,
          ci_upper: h.confidenceInterval.upper,
          key_drivers: run.keyDrivers,
          model_version: run.modelVersion,
          created_at: run.createdAt,
        })),
      );
    },
  };
}

export type DataAdapters = ReturnType<typeof createDataAdapters>;
