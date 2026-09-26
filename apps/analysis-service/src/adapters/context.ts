import { getBigQuery } from '@vayusetu/gcp-clients';
import type { Submission } from '@vayusetu/shared-types';
import type { LoadedContext } from '../pipeline/analyze.js';
import { categoryForAqi, istLabel, seasonFor, type Reference } from '../pipeline/crossValidate.js';

export interface ContextRow {
  corridor_id?: string | null;
  nearest_station_id?: string | null;
  nearest_station_distance_km?: number | null;
  gt_aqi?: number | null;
  gt_ts?: { value: string } | string | null;
  sat_aai?: number | null;
  sat_aod?: number | null;
  sat_no2?: number | null;
  sat_date?: { value: string } | string | null;
}

const asString = (v: { value: string } | string | null | undefined) => (v && typeof v === 'object' ? v.value : v ?? undefined);

/**
 * One query: the report's cell (corridor, nearest official monitor), that
 * monitor's latest station AQI, and the cell's latest satellite features.
 * All joins go through core.h3_cells -- BigQuery has no H3.
 */
export const CONTEXT_SQL = (project: string, dataset: string) => `
WITH cell AS (
  SELECT corridor_id, nearest_station_id, nearest_station_distance_km
  FROM \`${project}.${dataset}.h3_cells\` WHERE h3_index = @h3 LIMIT 1
), gt AS (
  SELECT aqi, TIMESTAMP_ADD(TIMESTAMP(observation_date), INTERVAL observation_hour HOUR) AS ts
  FROM \`${project}.${dataset}.ground_truth_aqi\`
  WHERE station_id = (SELECT nearest_station_id FROM cell) AND aqi IS NOT NULL
    AND observation_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 4 DAY)
  ORDER BY ts DESC LIMIT 1
), sat AS (
  SELECT aerosol_index, aod_550nm, no2_column_mol_m2, observation_date
  FROM \`${project}.${dataset}.satellite_features\`
  WHERE h3_index = @h3 AND observation_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 5 DAY)
  ORDER BY observation_date DESC LIMIT 1
)
SELECT
  (SELECT corridor_id FROM cell) AS corridor_id,
  (SELECT nearest_station_id FROM cell) AS nearest_station_id,
  (SELECT nearest_station_distance_km FROM cell) AS nearest_station_distance_km,
  (SELECT aqi FROM gt) AS gt_aqi, (SELECT ts FROM gt) AS gt_ts,
  (SELECT aerosol_index FROM sat) AS sat_aai, (SELECT aod_550nm FROM sat) AS sat_aod,
  (SELECT no2_column_mol_m2 FROM sat) AS sat_no2, (SELECT observation_date FROM sat) AS sat_date`;

export interface ModeledPointAqi {
  aqi: number;
  observedAt?: string;
}

/**
 * Pure: DB row + optional live Air Quality API value -> Pipeline A context
 * and the cross-validation reference. A monitor reading is the reference only
 * when it is fresh AND close; otherwise the Air Quality API's modeled AQI at
 * the exact point is (Google's model, clearly labelled as such).
 */
export function assembleContext(
  sub: Submission,
  row: ContextRow | undefined,
  modeled: ModeledPointAqi | undefined,
  opts: { now: Date; monitorFreshHours: number; monitorMaxDistanceKm: number },
): LoadedContext {
  const captured = new Date(sub.capturedAt);
  const at = Number.isNaN(captured.getTime()) ? opts.now : captured;
  const gtTs = asString(row?.gt_ts);
  const monitorAgeH = gtTs ? (opts.now.getTime() - new Date(gtTs).getTime()) / 3_600_000 : undefined;
  const monitorId = row?.nearest_station_id ?? undefined;
  const distance = row?.nearest_station_distance_km ?? undefined;
  const gtAqi = row?.gt_aqi ?? undefined;

  let reference: Reference | undefined;
  if (
    gtAqi !== undefined && monitorId && distance !== undefined && monitorAgeH !== undefined &&
    monitorAgeH <= opts.monitorFreshHours && distance <= opts.monitorMaxDistanceKm
  ) {
    reference = { aqi: gtAqi, source: 'monitor', label: `monitor ${monitorId} (${distance.toFixed(1)} km)` };
  } else if (modeled) {
    reference = { aqi: modeled.aqi, source: 'modeled', label: 'the Google Air Quality API model at this point' };
  }

  return {
    context: {
      localTime: istLabel(at),
      season: seasonFor(at),
      ...(monitorId && distance !== undefined
        ? {
            nearestMonitor: {
              id: monitorId,
              distanceKm: distance,
              ...(gtAqi !== undefined ? { aqi: gtAqi, aqiCategory: categoryForAqi(gtAqi), observedAt: gtTs } : {}),
            },
          }
        : {}),
      ...(row?.sat_aai != null || row?.sat_aod != null || row?.sat_no2 != null
        ? {
            satellite: {
              ...(row?.sat_aai != null ? { aerosolIndex: row.sat_aai } : {}),
              ...(row?.sat_aod != null ? { aod550nm: row.sat_aod } : {}),
              ...(row?.sat_no2 != null ? { no2ColumnMolM2: row.sat_no2 } : {}),
              observationDate: asString(row?.sat_date),
            },
          }
        : {}),
      ...(modeled ? { modeledAqi: { aqi: modeled.aqi, category: categoryForAqi(modeled.aqi), observedAt: modeled.observedAt } } : {}),
    },
    ...(row?.corridor_id ? { corridorId: row.corridor_id } : {}),
    ...(reference ? { reference } : {}),
    crossValidation: {
      ...(monitorId ? { nearestMonitorId: monitorId } : {}),
      ...(gtAqi !== undefined ? { nearestMonitorAQI: gtAqi } : {}),
      ...(row?.sat_aod != null ? { satelliteAODAtCell: row.sat_aod } : {}),
    },
  };
}

/** Air Quality API currentConditions at a point (CPCB index). Undefined on any failure -- context is best-effort. */
export async function fetchModeledAqi(lat: number, lng: number, apiKey: string, timeoutMs = 4000): Promise<ModeledPointAqi | undefined> {
  const res = await fetch(`https://airquality.googleapis.com/v1/currentConditions:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: { latitude: lat, longitude: lng }, extraComputations: ['LOCAL_AQI'], universalAqi: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { dateTime?: string; indexes?: Array<{ code?: string; aqi?: number }> };
  const cpcb = body.indexes?.find((i) => i.code === 'ind_cpcb');
  return cpcb?.aqi !== undefined ? { aqi: cpcb.aqi, observedAt: body.dateTime } : undefined;
}

export function createContextLoader(cfg: {
  project: string;
  dataset: string;
  mapsApiKey?: string;
  monitorFreshHours: number;
  monitorMaxDistanceKm: number;
  logger: { warn(obj: object, msg: string): void };
}) {
  const sql = CONTEXT_SQL(cfg.project, cfg.dataset);
  return async (sub: Submission): Promise<LoadedContext> => {
    const [rowsResult, modeled] = await Promise.all([
      getBigQuery().query({ query: sql, params: { h3: sub.h3Index } }),
      cfg.mapsApiKey
        ? fetchModeledAqi(sub.geo.lat, sub.geo.lng, cfg.mapsApiKey).catch((err) => {
            cfg.logger.warn({ err }, 'Air Quality API lookup failed');
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);
    const row = (rowsResult[0] as ContextRow[])[0];
    return assembleContext(sub, row, modeled, {
      now: new Date(),
      monitorFreshHours: cfg.monitorFreshHours,
      monitorMaxDistanceKm: cfg.monitorMaxDistanceKm,
    });
  };
}
