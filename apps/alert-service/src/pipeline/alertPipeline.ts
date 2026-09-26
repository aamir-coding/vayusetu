import { GeocodingError } from '@vayusetu/gcp-clients';
import type { Alert, AlertType, Corridor, ForecastRun, GeoPoint, HotspotCell, Jurisdiction } from '@vayusetu/shared-types';
import type { z } from 'zod';
import { alertsCollection, corridorsCollection, forecastsCollection, hotspotsCollection } from '../lib/collections.js';
import { cellCenter } from '../lib/geo.js';
import { AlertBriefingSchema, type BriefingGenerator, type BriefingInput } from '../domain/briefing.js';
import { type HotspotThresholds, SEVERITY_RANK, assessForecast, hotspotSeverity } from '../domain/severity.js';
import { OPEN_STATUSES } from '../domain/transitions.js';
import { CorridorSchema, ForecastRunSchema, HotspotCellSchema, describeIssues } from '../domain/docSchemas.js';
import { type NotificationGateway, toNotificationsSent } from '../notifications/gateway.js';
import type { Recipient } from '../notifications/types.js';

/**
 * FAILURE SEMANTICS (Pub/Sub push is at-least-once):
 *  - NonRetryableEventError -> route ACKs (204) and logs. For events that can
 *    never succeed (referenced doc missing, unknown corridor). Retrying those
 *    forever would just burn the retry budget.
 *  - Any other throw -> route returns 500 -> Pub/Sub redelivers with backoff,
 *    then dead-letters (infra/terraform pubsub.tf). Firestore/geocoding blips.
 *  - Alert ids are DETERMINISTIC (hotspot_<cellId>, forecast_<runId>_<state>)
 *    so a redelivered event can't create a second alert or page officials twice.
 *  - Notifications are at-least-once: if we crashed after creating the alert
 *    but before recording any delivery, a redelivery resumes dispatch. A rare
 *    duplicate push beats a silently missed critical alert.
 */
export class NonRetryableEventError extends Error {
  override name = 'NonRetryableEventError';
}

export interface PipelineDeps {
  briefing: BriefingGenerator;
  gateway: NotificationGateway;
  resolveJurisdiction: (geo: GeoPoint) => Promise<Jurisdiction>;
  findRecipients: (j: Jurisdiction) => Promise<Recipient[]>;
  hotspotThresholds: HotspotThresholds;
  suppressionWindowHours: number;
  fallbackStateCode: string;
  now: () => Date;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
}

export type EventOutcome =
  | { result: 'below_threshold' }
  | { result: 'suppressed'; alertId: string; by: string }
  | { result: 'created'; alertId: string; notified: number }
  | { result: 'duplicate'; alertId: string }
  | { result: 'resumed_dispatch'; alertId: string; notified: number };

export interface HotspotUpdatedPayload {
  hotspotCellId: string;
  corridorId: string;
  hotspotConfidenceScore: number;
}
export interface ForecastUpdatedPayload {
  forecastRunId: string;
  corridorId: string;
  maxHorizonAQI: number;
}

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 6 || code === 'already-exists';
}

async function dispatchAndRecord(alert: Alert, deps: PipelineDeps): Promise<number> {
  // This is the contract's `alert.created -> (notification dispatch, in-process)`.
  const recipients = await deps.findRecipients(alert.assignedJurisdiction);
  const results = await deps.gateway.dispatch(alert, recipients);
  const at = deps.now().toISOString();
  const entries = toNotificationsSent(results, at);
  if (entries.length > 0) {
    // update() touches only these fields, so it can't clobber a concurrent
    // status change an official makes through PATCH /alerts/:id/status.
    await alertsCollection().doc(alert.id).update({ notificationsSent: entries, updatedAt: at });
  }
  deps.logger.info(
    { alertId: alert.id, recipients: recipients.length, recorded: entries.length, simulated: results.length - entries.length },
    'alert dispatched',
  );
  return entries.length;
}

async function resumeOrDuplicate(existing: Alert, deps: PipelineDeps): Promise<EventOutcome> {
  // Only resume for an untouched alert: never page people about one an
  // official has already acknowledged or dismissed.
  if (existing.notificationsSent.length === 0 && existing.status === 'new') {
    const notified = await dispatchAndRecord(existing, deps);
    return { result: 'resumed_dispatch', alertId: existing.id, notified };
  }
  return { result: 'duplicate', alertId: existing.id };
}

async function findSuppressor(
  candidates: Alert[],
  newSeverityRank: number,
  deps: PipelineDeps,
): Promise<Alert | undefined> {
  const cutoff = new Date(deps.now().getTime() - deps.suppressionWindowHours * 3_600_000).toISOString();
  return candidates.find(
    (a) => OPEN_STATUSES.includes(a.status) && a.createdAt >= cutoff && SEVERITY_RANK[a.severity] >= newSeverityRank,
  );
}

async function createAndDispatch(alert: Alert, deps: PipelineDeps): Promise<EventOutcome> {
  const ref = alertsCollection().doc(alert.id);
  try {
    await ref.create(alert);
  } catch (error) {
    // Lost a race with a concurrent redelivery of the same event.
    if (isAlreadyExists(error)) return resumeOrDuplicate((await ref.get()).data()!, deps);
    throw error;
  }
  deps.logger.info({ alertId: alert.id, severity: alert.severity, jurisdiction: alert.assignedJurisdiction }, 'alert.created');
  const notified = await dispatchAndRecord(alert, deps);
  return { result: 'created', alertId: alert.id, notified };
}

function buildAlert(args: {
  id: string;
  type: AlertType;
  sourceRef: string;
  corridorId: string;
  h3Index?: string;
  severity: Alert['severity'];
  jurisdiction: Jurisdiction;
  briefing: ReturnType<typeof AlertBriefingSchema.parse>;
  now: string;
}): Alert {
  return {
    id: args.id,
    type: args.type,
    sourceRef: args.sourceRef,
    corridorId: args.corridorId,
    ...(args.h3Index ? { h3Index: args.h3Index } : {}),
    severity: args.severity,
    ...args.briefing,
    assignedJurisdiction: args.jurisdiction,
    status: 'new',
    statusHistory: [{ status: 'new', byUserId: 'system', at: args.now }],
    notificationsSent: [],
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/** Re-read + contract-validate an upstream doc. Missing or malformed are both
 *  permanent for THIS event -> NonRetryable (acked), with the exact field. */
async function readValidated<T>(
  ref: { get: () => Promise<{ exists: boolean; data: () => unknown }> },
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const snap = await ref.get();
  if (!snap.exists) throw new NonRetryableEventError(`${path} does not exist`);
  const parsed = schema.safeParse(snap.data());
  if (!parsed.success) {
    throw new NonRetryableEventError(`${path} violates the API_CONTRACTS.md shape: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** "Recent history for context" (Pipeline C). Best-effort: a failed lookup
 *  (e.g. index still building) degrades the briefing, never blocks the alert. */
async function recentHotspotHistory(cell: HotspotCell, deps: PipelineDeps): Promise<HotspotCell[]> {
  try {
    const snap = await hotspotsCollection()
      .where('h3Index', '==', cell.h3Index)
      .orderBy('timestampHour', 'desc')
      .limit(25)
      .get();
    return snap.docs
      .map((d) => HotspotCellSchema.safeParse(d.data()))
      .flatMap((r) => (r.success ? [r.data] : []))
      .filter((h) => h.id !== cell.id && h.timestampHour < cell.timestampHour)
      .slice(0, 24);
  } catch (error) {
    deps.logger.warn({ err: error, h3Index: cell.h3Index }, 'Hotspot history lookup failed; briefing without history');
    return [];
  }
}

async function recentForecastHistory(run: ForecastRun, deps: PipelineDeps): Promise<ForecastRun[]> {
  try {
    const snap = await forecastsCollection()
      .where('corridorId', '==', run.corridorId)
      .orderBy('forecastRunTimestamp', 'desc')
      .limit(4)
      .get();
    return snap.docs
      .map((d) => ForecastRunSchema.safeParse(d.data()))
      .flatMap((r) => (r.success ? [r.data] : []))
      .filter((r) => r.id !== run.id && r.forecastRunTimestamp < run.forecastRunTimestamp)
      .slice(0, 3);
  } catch (error) {
    deps.logger.warn({ err: error, corridorId: run.corridorId }, 'Forecast history lookup failed; briefing without history');
    return [];
  }
}

async function generateBriefing(input: BriefingInput, deps: PipelineDeps) {
  // Validate at the boundary even though the template is schema-checked
  // internally: in Week 3 this is where Gemini output enters the system.
  return AlertBriefingSchema.parse(await deps.briefing.generate(input));
}

export async function handleHotspotUpdated(payload: HotspotUpdatedPayload, deps: PipelineDeps): Promise<EventOutcome> {
  // §4.3: the payload carries the score precisely so subscribers can FILTER
  // without a read. Cheap early exit for the (majority) sub-threshold cells.
  if (hotspotSeverity(payload.hotspotConfidenceScore, deps.hotspotThresholds) === null) {
    return { result: 'below_threshold' };
  }

  // §4.3 design rule: always act on re-read state, never the payload.
  const cell = await readValidated<HotspotCell>(
    hotspotsCollection().doc(payload.hotspotCellId),
    `hotspots/${payload.hotspotCellId}`,
    HotspotCellSchema,
  );

  const severity = hotspotSeverity(cell.hotspotConfidenceScore, deps.hotspotThresholds);
  if (severity === null) return { result: 'below_threshold' };

  const corridor = await readValidated<Corridor>(
    corridorsCollection().doc(cell.corridorId),
    `corridors/${cell.corridorId}`,
    CorridorSchema,
  );

  const alertId = `hotspot_${cell.id}`;
  const existing = await alertsCollection().doc(alertId).get();
  if (existing.exists) return resumeOrDuplicate(existing.data()!, deps);

  // Same cell, still-open alert of >= severity -> don't page anyone again.
  // Equality-only query: no composite index needed.
  const sameCell = await alertsCollection().where('h3Index', '==', cell.h3Index).where('type', '==', 'hotspot').get();
  const suppressor = await findSuppressor(sameCell.docs.map((d) => d.data()), SEVERITY_RANK[severity], deps);
  if (suppressor) return { result: 'suppressed', alertId, by: suppressor.id };

  let jurisdiction: Jurisdiction;
  try {
    jurisdiction = await deps.resolveJurisdiction(cellCenter(cell.h3Index));
  } catch (error) {
    if (!(error instanceof GeocodingError) || error.kind !== 'no_result') throw error; // retryable
    // Route to state level so it's still seen by state admins, rather than dropped.
    jurisdiction = { stateCode: deps.fallbackStateCode };
    deps.logger.warn({ h3Index: cell.h3Index, alertId }, 'Cell centre did not geocode; routed to fallback state');
  }

  const history = await recentHotspotHistory(cell, deps);
  const briefing = await generateBriefing({ kind: 'hotspot', cell, corridor, jurisdiction, severity, history }, deps);
  const alert = buildAlert({
    id: alertId,
    type: 'hotspot',
    sourceRef: cell.id,
    corridorId: cell.corridorId,
    h3Index: cell.h3Index,
    severity,
    jurisdiction,
    briefing,
    now: deps.now().toISOString(),
  });
  return createAndDispatch(alert, deps);
}

/**
 * One alert PER STATE in the corridor, assigned at state level. An airshed
 * forecast (NCR spans DL/HR/UP/RJ) has no single owner, and Alert carries a
 * single assignedJurisdiction -- so each state's admins get their own
 * actionable, separately-trackable alert. This matches the admin-dashboard
 * fixture (NCR forecast alert assigned to {stateCode: 'DL'}), but the
 * contract doesn't spell it out: flagged in WEEK2_SETUP.md.
 */
export async function handleForecastUpdated(payload: ForecastUpdatedPayload, deps: PipelineDeps): Promise<EventOutcome[]> {
  const run = await readValidated<ForecastRun>(
    forecastsCollection().doc(payload.forecastRunId),
    `forecasts/${payload.forecastRunId}`,
    ForecastRunSchema,
  );
  const corridor = await readValidated<Corridor>(
    corridorsCollection().doc(run.corridorId),
    `corridors/${run.corridorId}`,
    CorridorSchema,
  );

  const assessment = assessForecast(run, corridor);
  if (!assessment || assessment.severity === null) return [{ result: 'below_threshold' }];
  const { severity, worst, impliedGrapStage } = assessment;

  const sameCorridor = (
    await alertsCollection().where('corridorId', '==', corridor.id).where('type', '==', 'forecast').get()
  ).docs.map((d) => d.data());

  const outcomes: EventOutcome[] = [];
  // ONE corridor-level briefing per run, generated lazily (only if some state
  // actually needs a new alert) and reused for every state: NCR's 4 states
  // cost 1 Gemini call, keeping the whole event well inside the ack deadline.
  let sharedBriefing: Awaited<ReturnType<typeof generateBriefing>> | undefined;
  const briefingForRun = async () => {
    sharedBriefing ??= await generateBriefing(
      {
        kind: 'forecast', run, corridor, severity, worst, impliedGrapStage,
        history: await recentForecastHistory(run, deps),
      },
      deps,
    );
    return sharedBriefing;
  };

  for (const stateCode of corridor.states) {
    const alertId = `forecast_${run.id}_${stateCode}`;
    const existing = await alertsCollection().doc(alertId).get();
    if (existing.exists) {
      outcomes.push(await resumeOrDuplicate(existing.data()!, deps));
      continue;
    }

    const suppressor = await findSuppressor(
      sameCorridor.filter((a) => a.assignedJurisdiction.stateCode === stateCode),
      SEVERITY_RANK[severity],
      deps,
    );
    if (suppressor) {
      outcomes.push({ result: 'suppressed', alertId, by: suppressor.id });
      continue;
    }

    const jurisdiction: Jurisdiction = { stateCode };
    const briefing = await briefingForRun();
    outcomes.push(
      await createAndDispatch(
        buildAlert({
          id: alertId,
          type: 'forecast',
          sourceRef: run.id,
          corridorId: run.corridorId,
          severity,
          jurisdiction,
          briefing,
          now: deps.now().toISOString(),
        }),
        deps,
      ),
    );
  }
  return outcomes;
}
