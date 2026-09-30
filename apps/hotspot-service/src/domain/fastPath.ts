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
  config: { hiddenMinConfidence: number; modelHiddenMinConfidence?: number; alertMinScore: number; minConfidence: number; minAgreement: number };
}

/** Local sources a distant monitor is not expected to see. */
const POINT_SOURCES = new Set(['open_waste_burning', 'crop_residue_burning', 'industrial_emission', 'construction_dust']);
/** Confidence at which a visible plume counts even against the monitor. */
export const VISIBLE_PLUME_MIN_CONFIDENCE = 0.8;

/**
 * Does a citizen report count as evidence for the heatmap?
 *
 * A VISIBLE point-source plume (fire, stack, dust cloud) counts even when it
 * disagrees with the nearest monitor or modeled AQI -- a garbage fire 2 km
 * from a monitor is precisely the hidden hotspot this engine exists to find,
 * and "disagrees with the monitor" is what flags it for review. The review
 * flag keeps the REPORT in front of officials; it no longer hides the SPOT.
 * (27 Sep rehearsal: a real fire, confidence 0.95, was flagged because the
 * modeled AQI there read 64, and could never move the heatmap.)
 * Diffuse haze and uncertain calls still need agreement and no review flag.
 */
export function qualifies(r: AnalysisResult, minConfidence: number, minAgreement: number): boolean {
  if (r.sourceClassification === 'indeterminate' || r.sourceClassification === 'no_visible_pollution') return false;
  if (r.confidenceScore < minConfidence) return false;
  const visiblePlume = POINT_SOURCES.has(r.sourceClassification) && r.plumeDetected === true && r.confidenceScore >= VISIBLE_PLUME_MIN_CONFIDENCE;
  if (visiblePlume) return true;
  if (r.needsHumanReview) return false;
  const agreement = r.crossValidation?.agreementScore;
  return agreement === undefined || agreement >= minAgreement;
}

const MODEL_SCORE_MAX_AGE_H = 3;

/** Newest reports a single fast-path rescore considers (audit M3): bounds the reads when a cell is flooded. */
export const MAX_FAST_PATH_REPORTS = 200;

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
  // orderBy DESC is load-bearing: without it Firestore sorts the range field
  // ASCENDING, which needs an index nobody declared -- only (h3Index,
  // uploadedAt DESC) exists -- and every fast-path event failed live with
  // FAILED_PRECONDITION until the 28 Sep rehearsal caught it.
  const subs = (
    await db.collection('submissions').where('h3Index', '==', event.h3Index).where('uploadedAt', '>=', since).orderBy('uploadedAt', 'desc').limit(MAX_FAST_PATH_REPORTS).get()
  ).docs.map((d) => d.data() as Submission);
  // One vote per citizen: evidence is DISTINCT people, so one phone (or a
  // spammer) re-reporting the same spot cannot push a cell to an alert alone.
  const byUser = new Map<string, AnalysisResult>();
  // ONE batched read for all the analyses, not one round-trip per report
  // (audit M3: a busy or spammed cell made every event slower).
  const snaps = subs.length ? await db.getAll(...subs.map((s) => db.collection('analysisResults').doc(s.id))) : [];
  for (const [i, s] of subs.entries()) {
    const snap = snaps[i]!;
    const r = snap.exists ? (snap.data() as AnalysisResult) : undefined;
    if (!r || !qualifies(r, deps.config.minConfidence, deps.config.minAgreement)) continue;
    const prev = byUser.get(s.userId);
    if (!prev || r.confidenceScore > prev.confidenceScore) byUser.set(s.userId, r);
  }
  const results = [...byUser.values()];
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
