import type { AlertSeverity, Corridor, ForecastHorizonPoint, ForecastRun, GRAPStage } from '@vayusetu/shared-types';

/**
 * AI_PIPELINES.md, Pipeline C: "severity is a value alert-service computes
 * deterministically from the underlying hotspot/forecast numbers BEFORE
 * calling Gemini ... we do not let the model decide how urgent its own
 * briefing is." Everything in this file is that deterministic computation.
 * No I/O here -- pure functions, exhaustively unit-tested.
 */

/** Numeric urgency order. Use this for any comparison or sorting -- NEVER the
 *  severity string itself: lexicographically, 'watch' > 'warning' > 'info' >
 *  'critical', i.e. critical sorts LAST. (DB_SCHEMA.md's alerts index sorts
 *  `severity DESC` on the string -- flagged in WEEK2_SETUP.md.) */
export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, watch: 1, warning: 2, critical: 3 };

export const GRAP_STAGE_RANK: Record<GRAPStage, number> = { none: 0, stage_1: 1, stage_2: 2, stage_3: 3, stage_4: 4 };

export interface HotspotThresholds {
  watch: number;
  warning: number;
  critical: number;
}

export function parseHotspotThresholds([watch, warning, critical]: number[]): HotspotThresholds {
  return { watch: watch!, warning: warning!, critical: critical! };
}

/** null => below the alerting threshold; no alert is created. */
export function hotspotSeverity(score: number, t: HotspotThresholds): AlertSeverity | null {
  if (score >= t.critical) return 'critical';
  if (score >= t.warning) return 'warning';
  if (score >= t.watch) return 'watch';
  return null;
}

/** Highest stage whose lower bound the AQI reaches. Uses only thresholds the
 *  corridor actually configured -- never invents one (Pipeline C rule). */
export function aqiToGrapStage(aqi: number, thresholds: Corridor['grapThresholds']): GRAPStage {
  if (!thresholds) return 'none';
  const stages = (['stage_4', 'stage_3', 'stage_2', 'stage_1'] as const).filter((s) => thresholds[s]);
  for (const stage of stages) {
    if (aqi >= thresholds[stage].aqiMin) return stage;
  }
  return 'none';
}

const SEVERITY_BY_GRAP: Record<GRAPStage, AlertSeverity | null> = {
  none: null,
  stage_1: 'watch',
  stage_2: 'warning',
  stage_3: 'critical',
  stage_4: 'critical',
};

/**
 * Corridors without an active GRAP framework (e.g. Mumbai-Pune) fall back to
 * CPCB's National AQI category bands -- official breakpoints, not invented
 * ones: Poor 201-300, Very Poor 301-400, Severe 401-500.
 */
function naqiSeverity(aqi: number): AlertSeverity | null {
  if (aqi >= 401) return 'critical';
  if (aqi >= 301) return 'warning';
  if (aqi >= 201) return 'watch';
  return null;
}

/** Worst point across horizons; on an AQI tie, the NEAREST horizon wins
 *  (a 24 h breach is more actionable than the same value at 72 h). */
export function worstHorizon(run: ForecastRun): ForecastHorizonPoint | undefined {
  return [...run.horizons].sort((a, b) => b.predictedAQI - a.predictedAQI || a.horizonHours - b.horizonHours)[0];
}

export interface ForecastAssessment {
  worst: ForecastHorizonPoint;
  impliedGrapStage: GRAPStage;
  severity: AlertSeverity | null;
}

export function assessForecast(run: ForecastRun, corridor: Corridor): ForecastAssessment | null {
  const worst = worstHorizon(run);
  if (!worst) return null;
  const grapActive = corridor.grapFrameworkActive && Boolean(corridor.grapThresholds);
  const impliedGrapStage = grapActive ? aqiToGrapStage(worst.predictedAQI, corridor.grapThresholds) : 'none';
  const severity = grapActive ? SEVERITY_BY_GRAP[impliedGrapStage] : naqiSeverity(worst.predictedAQI);
  return { worst, impliedGrapStage, severity };
}
