import type { HotspotCell, PollutionSourceType } from '@vayusetu/shared-types';
import {
  hiddenThreshold,
  hourIso,
  scoreCell,
  selectForPublication,
  toHotspotCell,
  type FeatureRow,
  type ScoredCell,
} from './fusion.js';
import type { ModelScorer } from '../scoring/scorers.js';

export interface HourlyConfig {
  hiddenMinConfidence: number;
  modelHiddenMinConfidence?: number;
  firestoreMinScore: number;
  firestoreMaxCells: number;
  alertMinScore: number;
  alertMaxPerCorridor: number;
}

export interface HourlyDeps {
  /** Materialise core.hotspot_features for the hour; rows + (for batch scoring) the table they live in. */
  loadFeatures(hourIso: string): Promise<{ rows: FeatureRow[]; inputTable?: string }>;
  /** Most common citizen classification per cell over the last 3 h (core.citizen_reports_agg). */
  citizenModes(hourIso: string): Promise<Map<string, PollutionSourceType>>;
  scorer: ModelScorer;
  /** Idempotent: replaces every row of this hour in core.hotspot_cells. */
  writeGrid(hourIso: string, cells: ScoredCell[]): Promise<void>;
  /** Firestore hotspots/{id} -- the heatmap's top cells. MUST complete before publishing (alert-service re-reads). */
  writeTopCells(docs: Array<HotspotCell & { modelScore: number; expireAt: Date }>): Promise<void>;
  publishHotspotUpdated(p: { hotspotCellId: string; corridorId: string; hotspotConfidenceScore: number }): Promise<void>;
  now(): Date;
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  config: HourlyConfig;
}

export interface HourlySummary {
  hour: string;
  cells: number;
  modelVersion: string;
  hidden: number;
  firestore: number;
  published: number;
  maxScore: number;
}

/** One hourly run of the Hotspot Fusion Engine (Cloud Run Job, Cloud Scheduler). */
export async function runHourly(hourTs: string | Date, deps: HourlyDeps): Promise<HourlySummary> {
  const hour = hourIso(hourTs);
  const { rows, inputTable } = await deps.loadFeatures(hour);
  if (rows.length === 0) throw new Error(`hotspot_features returned no cells for ${hour} -- run ingestion seed (h3_cells)`);

  const [{ probabilities, modelVersion }, modes] = await Promise.all([
    deps.scorer.score(rows, { hourIso: hour, inputTable }),
    deps.citizenModes(hour),
  ]);
  const scored = rows.map((row, i) =>
    scoreCell(row, probabilities[i] ?? 0, modelVersion, {
      hiddenMinConfidence: hiddenThreshold(modelVersion, deps.config),
      citizenMode: modes.get(row.h3_index),
    }),
  );

  await deps.writeGrid(hour, scored);
  const { firestore, alerts } = selectForPublication(scored, deps.config);
  const createdAt = deps.now().toISOString();
  const docs = firestore.map((c) => ({
    ...toHotspotCell(c, c.row.nearest_station_id ?? undefined, createdAt),
    // Not part of the HotspotCell contract (alert-service's Zod strips extras):
    // the fast path needs the pre-fusion model score; expireAt drives the
    // Firestore TTL policy so heatmap docs don't accumulate forever.
    modelScore: c.pModel,
    expireAt: new Date(deps.now().getTime() + 7 * 86_400_000),
  }));
  await deps.writeTopCells(docs);

  // alert-service re-reads the doc, so only cells written to Firestore are published.
  const written = new Set(docs.map((d) => d.id));
  let published = 0;
  for (const c of alerts) {
    const doc = toHotspotCell(c, undefined, createdAt);
    if (!written.has(doc.id)) continue;
    await deps.publishHotspotUpdated({ hotspotCellId: doc.id, corridorId: doc.corridorId, hotspotConfidenceScore: doc.hotspotConfidenceScore });
    published++;
  }

  const summary: HourlySummary = {
    hour,
    cells: scored.length,
    modelVersion,
    hidden: scored.filter((c) => c.isHidden).length,
    firestore: docs.length,
    published,
    maxScore: scored.reduce((m, c) => Math.max(m, c.score), 0),
  };
  deps.logger.info({ ...summary }, 'hotspot hourly run complete');
  return summary;
}
