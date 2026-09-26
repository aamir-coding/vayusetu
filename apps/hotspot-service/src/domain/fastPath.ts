import { getDb, NonRetryableEventError } from '@vayusetu/gcp-clients';
import type { AnalysisResult, HotspotCell, PollutionSourceType, Submission } from '@vayusetu/shared-types';
import { citizenProbability, fuse, hourIso, hourKey } from './fusion.js';

/**
 * analysis.completed fast path: a verified citizen report re-scores its cell
 * within seconds instead of waiting for the hourly run. The model component
 * is the latest hourly model score for the cell (<= 3 h old); the citizen
 * component is recomputed from every qualifying report in the cell over the
 * last 3 h -- the same gate as the hourly rollup (ingestion `rollup` job).
 */

export interface FastPathDeps {
  /** core.h3_cells lookup: corridor + whether an official monitor is within 3 km. */
  cellInfo(h3Index: string): Promise<{ corridorId: string; hasMonitorWithinRadius: boolean; nearestStationId?: string } | undefined>;
  publishHotspotUpdated(p: { hotspotCellId: string; corridorId: string; hotspotConfidenceScore: number }): Promise<void>;
  now(): Date;
  logger: { info(obj: object, msg: string): void };
  config: { hiddenMinConfidence: number; alertMinScore: number; minConfidence: number; minAgreement: number };
}

export function qualifies(r: AnalysisResult, minConfidence: number, minAgreement: number): boolean {
  if (r.needsHumanReview || r.sourceClassification === 'indeterminate' || r.sourceClassification === 'no_visible_pollution') return false;
  if (r.confidenceScore < minConfidence) return false;
  const agreement = r.crossValidation?.agreementScore;
  return agreement === undefined || agreement >= minAgreement;
}

const MODEL_SCORE_MAX_AGE_H = 3;

type HotspotDoc = HotspotCell & { modelScore?: number; expireAt?: Date };

export async function handleAnalysisCompleted(
  event: { submissionId: string; h3Index: string; corridorId: string },
  deps: FastPathDeps,
): Promise<'rescored' | 'no_qualifying_reports'> {
  const db = getDb();
  const cell = await deps.cellInfo(event.h3Index);
  if (!cell) throw new NonRetryableEventError(`h3 cell ${event.h3Index} is not in any corridor grid`);

  const now = deps.now();
  const since = new Date(now.getTime() - 3 * 3_600_000).toISOString();
  const subs = (await db.collection('submissions').where('h3Index', '==', event.h3Index).where('uploadedAt', '>=', since).get())
    .docs.map((d) => d.data() as Submission);
  const results: AnalysisResult[] = [];
  for (const s of subs) {
    const snap = await db.collection('analysisResults').doc(s.id).get();
    const r = snap.exists ? (snap.data() as AnalysisResult) : undefined;
    if (r && qualifies(r, deps.config.minConfidence, deps.config.minAgreement)) results.push(r);
  }
  if (results.length === 0) return 'no_qualifying_reports';

  const avgSeverity = results.reduce((s, r) => s + r.severityEstimate, 0) / results.length;
  const pCitizen = citizenProbability(results.length, avgSeverity);
  const counts = new Map<PollutionSourceType, number>();
  for (const r of results) counts.set(r.sourceClassification, (counts.get(r.sourceClassification) ?? 0) + 1);
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  // Latest hourly model score for this cell, if fresh enough.
  const latest = (await db.collection('hotspots').where('h3Index', '==', event.h3Index).orderBy('timestampHour', 'desc').limit(1).get())
    .docs[0]?.data() as HotspotDoc | undefined;
  const fresh = latest && now.getTime() - new Date(latest.timestampHour).getTime() <= MODEL_SCORE_MAX_AGE_H * 3_600_000;
  const pModel = fresh ? (latest.modelScore ?? 0) : 0;

  const timestampHour = hourIso(now);
  const id = `${event.h3Index}_${hourKey(timestampHour)}`;
  const score = fuse(pModel, pCitizen);
  const previous = (await db.collection('hotspots').doc(id).get()).data() as HotspotDoc | undefined;
  const signals: HotspotCell['contributingSignals'] = {
    ...(previous?.contributingSignals ?? latest?.contributingSignals ?? {}),
    citizenReportCount: results.length,
    avgCitizenSeverity: Math.round(avgSeverity * 100) / 100,
    ...(cell.nearestStationId ? { nearestMonitorId: cell.nearestStationId } : {}),
  };
  const doc: HotspotDoc = {
    id,
    h3Index: event.h3Index,
    corridorId: cell.corridorId,
    timestampHour,
    hotspotConfidenceScore: score,
    isHidden: score >= deps.config.hiddenMinConfidence && !cell.hasMonitorWithinRadius,
    classification: mode,
    contributingSignals: signals,
    modelVersion: fresh ? `${latest.modelVersion}+citizen` : 'citizen-evidence',
    createdAt: now.toISOString(),
    modelScore: pModel,
    expireAt: new Date(now.getTime() + 7 * 86_400_000),
  };
  await db.collection('hotspots').doc(id).set(doc);

  // Publish only when this report pushed the cell across the alert line
  // (alert-service dedupes too; this just avoids pointless events).
  const before = previous?.hotspotConfidenceScore ?? (fresh ? latest.hotspotConfidenceScore : 0);
  if (score >= deps.config.alertMinScore && score > before) {
    await deps.publishHotspotUpdated({ hotspotCellId: id, corridorId: cell.corridorId, hotspotConfidenceScore: score });
  }
  deps.logger.info({ id, reports: results.length, pModel, pCitizen, score }, 'fast-path rescore');
  return 'rescored';
}
