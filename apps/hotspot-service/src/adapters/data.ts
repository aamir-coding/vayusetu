import { getBigQuery, getDb } from '@vayusetu/gcp-clients';
import type { HotspotCell, PollutionSourceType } from '@vayusetu/shared-types';
import type { FeatureRow, ScoredCell } from '../domain/fusion.js';

/** BigQuery TIMESTAMP/DATE values arrive as { value } objects. */
function plain<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v && typeof v === 'object' && 'value' in (v as object) ? (v as { value: unknown }).value : v;
  }
  return out as T;
}

export function createDataAdapters(cfg: { project: string; dataset: string; location: string }) {
  const t = (name: string) => `\`${cfg.project}.${cfg.dataset}.${name}\``;
  const bq = () => getBigQuery();
  const query = async (sql: string, params?: Record<string, unknown>) => {
    const [rows] = await bq().query({ query: sql, params, location: cfg.location });
    return (rows as Array<Record<string, unknown>>).map((r) => plain<Record<string, unknown>>(r));
  };

  return {
    query,

    /** Materialises the hour's features (the batch scorer reads the table) and returns the rows. */
    async loadFeatures(hourIso: string): Promise<{ rows: FeatureRow[]; inputTable: string }> {
      const inputTable = `${cfg.project}.${cfg.dataset}.hotspot_scoring_input`;
      await query(
        `CREATE OR REPLACE TABLE \`${inputTable}\`
         OPTIONS (expiration_timestamp = TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)) AS
         SELECT * FROM ${t('hotspot_features')}(TIMESTAMP(@hour), TIMESTAMP_ADD(TIMESTAMP(@hour), INTERVAL 1 HOUR), [])`,
        { hour: hourIso },
      );
      const rows = (await query(`SELECT * FROM \`${inputTable}\``)) as unknown as FeatureRow[];
      return { rows, inputTable };
    },

    async citizenModes(hourIso: string): Promise<Map<string, PollutionSourceType>> {
      const rows = await query(
        `SELECT h3_index, APPROX_TOP_COUNT(source_classification_mode, 1)[OFFSET(0)].value AS mode
         FROM ${t('citizen_reports_agg')}
         WHERE TIMESTAMP_ADD(TIMESTAMP(observation_date), INTERVAL observation_hour HOUR)
               BETWEEN TIMESTAMP_SUB(TIMESTAMP(@hour), INTERVAL 2 HOUR) AND TIMESTAMP(@hour)
           AND source_classification_mode IS NOT NULL
         GROUP BY h3_index`,
        { hour: hourIso },
      );
      return new Map(rows.map((r) => [String(r.h3_index), r.mode as PollutionSourceType]));
    },

    /** Idempotent: delete the hour, then load. */
    async writeGrid(hourIso: string, cells: ScoredCell[]): Promise<void> {
      await query(`DELETE FROM ${t('hotspot_cells')} WHERE timestamp_hour = TIMESTAMP(@hour)`, { hour: hourIso });
      const now = new Date().toISOString();
      const rows = cells.map((c) => ({
        id: `${c.row.h3_index}_${hourIso.slice(0, 13)}`,
        h3_index: c.row.h3_index,
        corridor_id: c.row.corridor_id,
        timestamp_hour: hourIso,
        hotspot_confidence_score: c.score,
        model_score: c.pModel,
        citizen_score: c.pCitizen,
        is_hidden: c.isHidden,
        classification: c.classification,
        citizen_report_count: c.row.citizen_report_count_3h,
        avg_citizen_severity: c.row.citizen_avg_severity_3h,
        satellite_aod: c.row.sat_aod,
        satellite_no2: c.row.sat_no2,
        fire_detection_count: c.row.sat_fire_count == null ? null : Math.round(c.row.sat_fire_count),
        nearest_monitor_id: c.row.nearest_station_id,
        nearest_monitor_delta_aqi: null,
        model_version: c.modelVersion,
        created_at: now,
      }));
      // A LOAD job, not streaming inserts: streamed rows sit in a buffer that
      // DELETE can't touch for up to ~90 min, which would break re-running an hour.
      await loadJson(bq().dataset(cfg.dataset).table('hotspot_cells'), rows);
    },

    async writeTopCells(docs: Array<HotspotCell & { modelScore: number; expireAt: Date }>): Promise<void> {
      const db = getDb();
      for (let i = 0; i < docs.length; i += 400) {
        const batch = db.batch();
        for (const d of docs.slice(i, i + 400)) batch.set(db.collection('hotspots').doc(d.id), d);
        await batch.commit();
      }
    },

    async cellInfo(h3Index: string) {
      const [row] = await query(
        `SELECT corridor_id, has_monitor_within_radius, nearest_station_id FROM ${t('h3_cells')} WHERE h3_index = @h3 LIMIT 1`,
        { h3: h3Index },
      );
      if (!row) return undefined;
      return {
        corridorId: String(row.corridor_id),
        hasMonitorWithinRadius: Boolean(row.has_monitor_within_radius),
        ...(row.nearest_station_id ? { nearestStationId: String(row.nearest_station_id) } : {}),
      };
    },

    /** GET /hotspots/:h3/history -- full-grid rows from BigQuery as HotspotCell. */
    async history(h3Index: string, sinceIso: string): Promise<HotspotCell[]> {
      const rows = await query(
        `SELECT * FROM ${t('hotspot_cells')} WHERE h3_index = @h3 AND timestamp_hour >= TIMESTAMP(@since) ORDER BY timestamp_hour`,
        { h3: h3Index, since: sinceIso },
      );
      return rows.map(bqRowToHotspotCell);
    },

    async cellExists(h3Index: string): Promise<boolean> {
      const [row] = await query(`SELECT 1 AS ok FROM ${t('h3_cells')} WHERE h3_index = @h3 LIMIT 1`, { h3: h3Index });
      return Boolean(row);
    },
  };
}

export type DataAdapters = ReturnType<typeof createDataAdapters>;

type LoadableTable = {
  createWriteStream(metadata: object): NodeJS.WritableStream & { on(event: string, cb: (arg: unknown) => void): unknown };
};

/** NDJSON load job (WRITE_APPEND) that resolves when BigQuery reports the job done. */
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

export function bqRowToHotspotCell(r: Record<string, unknown>): HotspotCell {
  const ts = new Date(String(r.timestamp_hour)).toISOString();
  const signals: HotspotCell['contributingSignals'] = { citizenReportCount: Number(r.citizen_report_count ?? 0) };
  if (r.avg_citizen_severity != null) signals.avgCitizenSeverity = Number(r.avg_citizen_severity);
  if (r.satellite_aod != null) signals.satelliteAOD = Number(r.satellite_aod);
  if (r.satellite_no2 != null) signals.satelliteNO2 = Number(r.satellite_no2);
  if (r.fire_detection_count != null) signals.fireDetectionCount = Number(r.fire_detection_count);
  if (r.nearest_monitor_id != null) signals.nearestMonitorId = String(r.nearest_monitor_id);
  if (r.nearest_monitor_delta_aqi != null) signals.nearestMonitorDeltaAQI = Number(r.nearest_monitor_delta_aqi);
  return {
    id: String(r.id),
    h3Index: String(r.h3_index),
    corridorId: String(r.corridor_id),
    timestampHour: ts,
    hotspotConfidenceScore: Number(r.hotspot_confidence_score),
    isHidden: Boolean(r.is_hidden),
    classification: r.classification as HotspotCell['classification'],
    contributingSignals: signals,
    modelVersion: String(r.model_version),
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
}
