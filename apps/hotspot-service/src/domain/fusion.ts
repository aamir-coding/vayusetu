import type { HotspotCell, PollutionSourceType } from '@vayusetu/shared-types';

/**
 * Hotspot Fusion Engine -- pure functions, no I/O (PRODUCT_SPEC Feature 2).
 *
 *   p_model   : Hotspot Confidence Model (AutoML Tabular) on satellite,
 *               weather, calendar and regional-background features
 *   p_citizen : evidence from verified citizen reports in the cell (last 3 h)
 *   score     = 1 - (1 - p_model)(1 - p_citizen)     (independent evidence)
 *   isHidden  = score >= hiddenMinConfidence AND no official monitor within 3 km
 *
 * Citizen evidence is fused OUTSIDE the model on purpose: history holds no
 * citizen reports to learn from, and this lets one report move a cell within
 * seconds (analysis.completed fast path) instead of waiting for the hourly run.
 */

/** One row of core.hotspot_features (BigQuery returns snake_case). */
export interface FeatureRow {
  h3_index: string;
  corridor_id: string;
  ts: string;
  has_monitor_within_radius: boolean;
  nearest_station_id: string | null;
  nearest_station_distance_km: number | null;
  h3_res6?: string | null;
  lat?: number | null;
  lng?: number | null;
  built_frac?: number | null;
  crops_frac?: number | null;
  trees_frac?: number | null;
  bare_frac?: number | null;
  night_lights?: number | null;
  population_density?: number | null;
  sat_no2: number | null;
  sat_aerosol_index: number | null;
  sat_aod: number | null;
  sat_fire_count: number | null;
  sat_burn_scar: number | null;
  wind_speed_ms: number | null;
  wind_dir_sin: number | null;
  wind_dir_cos: number | null;
  temperature_c: number | null;
  relative_humidity_pct: number | null;
  precipitation_mm: number | null;
  citizen_report_count_3h: number;
  citizen_avg_severity_3h: number | null;
  nearest_station_aqi_d2: number | null;
  regional_aqi_d2: number | null;
  regional_station_count_d2: number | null;
  hour_ist: number;
  day_of_week: number;
  month: number;
  is_harvest_season: boolean;
  is_diwali_window: boolean;
}

export const CITIZEN_RATE = 0.35;
export const CITIZEN_CAP = 0.95;

/** Saturating evidence: 1 severe report ~0.37, 3 ~0.75, 5 ~0.90 (severity 4 of 5). */
export function citizenProbability(reports: number, avgSeverity: number | null | undefined): number {
  if (reports <= 0) return 0;
  const weight = reports * ((avgSeverity ?? 3) / 3);
  return Math.min(CITIZEN_CAP, 1 - Math.exp(-CITIZEN_RATE * weight));
}

export function fuse(pModel: number, pCitizen: number): number {
  const p = 1 - (1 - clamp01(pModel)) * (1 - clamp01(pCitizen));
  return Math.round(p * 10_000) / 10_000;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * Bootstrap scorer (modelVersion "heuristic-v0") used until the first AutoML
 * model is registered, or when Vertex AI is unreachable. A transparent
 * logistic over the same features; NOT a substitute for the trained model.
 */
export function heuristicProbability(r: FeatureRow): number {
  let z = -4.0;
  if (r.sat_aod != null) z += 2.2 * Math.min(Math.max(r.sat_aod - 0.4, 0), 1.5);
  if (r.sat_aerosol_index != null) z += 0.6 * Math.max(r.sat_aerosol_index, 0);
  if (r.sat_no2 != null) z += Math.min(r.sat_no2 * 8000, 1.5); // mol/m2: urban ~1e-4
  if (r.sat_fire_count) z += Math.min(0.9 * r.sat_fire_count, 2.5);
  if (r.sat_burn_scar != null) z += 2 * r.sat_burn_scar;
  if (r.wind_speed_ms != null) z += r.wind_speed_ms < 2 ? 0.8 : r.wind_speed_ms < 4 ? 0.3 : -0.4; // stagnation
  if (r.regional_aqi_d2 != null) z += r.regional_aqi_d2 >= 300 ? 1.0 : r.regional_aqi_d2 >= 200 ? 0.5 : 0;
  if (r.is_harvest_season) z += 0.5;
  if (r.is_diwali_window) z += 0.6;
  if (r.precipitation_mm != null && r.precipitation_mm > 1) z -= 1.0; // washout
  return 1 / (1 + Math.exp(-z));
}

export function classify(
  r: Pick<FeatureRow, 'sat_fire_count' | 'is_harvest_season'>,
  citizenMode: PollutionSourceType | undefined,
): HotspotCell['classification'] {
  if (citizenMode && citizenMode !== 'indeterminate' && citizenMode !== 'no_visible_pollution') return citizenMode;
  if ((r.sat_fire_count ?? 0) > 0) return r.is_harvest_season ? 'crop_residue_burning' : 'mixed';
  return 'unknown';
}

/** `${h3Index}_${YYYY-MM-DDTHH}` -- the id alert-service and the dashboard expect. */
export function hourKey(ts: string | Date): string {
  return new Date(ts).toISOString().slice(0, 13);
}

export function hourIso(ts: string | Date): string {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export interface ScoredCell {
  row: FeatureRow;
  pModel: number;
  pCitizen: number;
  score: number;
  isHidden: boolean;
  classification: HotspotCell['classification'];
  modelVersion: string;
}

export function scoreCell(
  row: FeatureRow,
  pModel: number,
  modelVersion: string,
  opts: { hiddenMinConfidence: number; citizenMode?: PollutionSourceType },
): ScoredCell {
  const pCitizen = citizenProbability(row.citizen_report_count_3h, row.citizen_avg_severity_3h);
  const score = fuse(pModel, pCitizen);
  return {
    row,
    pModel,
    pCitizen,
    score,
    isHidden: score >= opts.hiddenMinConfidence && !row.has_monitor_within_radius,
    classification: classify(row, opts.citizenMode),
    modelVersion,
  };
}

/** API_CONTRACTS.md HotspotCell -- optional fields ABSENT (not null): alert-service validates with Zod. */
export function toHotspotCell(c: ScoredCell, nearestMonitorId: string | undefined, createdAt: string): HotspotCell {
  const r = c.row;
  const signals: HotspotCell['contributingSignals'] = { citizenReportCount: r.citizen_report_count_3h };
  if (r.citizen_avg_severity_3h != null) signals.avgCitizenSeverity = round(r.citizen_avg_severity_3h, 2);
  if (r.sat_aod != null) signals.satelliteAOD = round(r.sat_aod, 3);
  if (r.sat_no2 != null) signals.satelliteNO2 = r.sat_no2;
  if (r.sat_fire_count != null) signals.fireDetectionCount = Math.max(0, Math.round(r.sat_fire_count));
  if (nearestMonitorId) signals.nearestMonitorId = nearestMonitorId;
  const timestampHour = hourIso(r.ts);
  return {
    id: `${r.h3_index}_${hourKey(timestampHour)}`,
    h3Index: r.h3_index,
    corridorId: r.corridor_id,
    timestampHour,
    hotspotConfidenceScore: c.score,
    isHidden: c.isHidden,
    classification: c.classification,
    contributingSignals: signals,
    modelVersion: c.modelVersion,
    createdAt,
  };
}

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

/** Which scored cells go to Firestore (the heatmap) and which raise hotspot.updated. */
export function selectForPublication(
  cells: ScoredCell[],
  opts: { firestoreMinScore: number; firestoreMaxCells: number; alertMinScore: number; alertMaxPerCorridor: number },
): { firestore: ScoredCell[]; alerts: ScoredCell[] } {
  const ranked = [...cells].sort((a, b) => b.score - a.score);
  const firestore = ranked.filter((c) => c.score >= opts.firestoreMinScore).slice(0, opts.firestoreMaxCells);
  const perCorridor = new Map<string, number>();
  const alerts = ranked.filter((c) => {
    if (c.score < opts.alertMinScore) return false;
    const n = perCorridor.get(c.row.corridor_id) ?? 0;
    if (n >= opts.alertMaxPerCorridor) return false;
    perCorridor.set(c.row.corridor_id, n + 1);
    return true;
  });
  return { firestore, alerts };
}
