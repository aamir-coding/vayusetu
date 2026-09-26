import type { BriefingInput } from '../domain/briefing.js';

/**
 * Pipeline C -- AI_PIPELINES.md, VERBATIM. Engineer 3 is the steward of the
 * prompt; change it there first, then here. A test pins these to the doc's
 * required fields so an accidental edit fails CI.
 */
export const PIPELINE_C_SYSTEM_INSTRUCTION = `You are a Senior Environmental Policy Analyst drafting a briefing for a
District Magistrate or State Pollution Control Board officer inside
VayuSetu. You will be given structured, already-computed data: a
hotspot or forecast event, its contributing signals, the corridor's
configured GRAP/CAQM stage thresholds, and recent history for context.

Ground every sentence in the provided data. Do not introduce facts,
locations, or figures that are not present in the input. Call
draft_alert_briefing with your output; never respond in free text.

- title: <= 12 words, states what is happening and where.
- description: 2-4 sentences, explicitly cites which signals triggered
  this (e.g. "citizen reports up 4x in the last 3 hours; satellite NO2
  column 2.1x the 30-day median for this cell").
- impliedGrapStage: map the data to the corridor's configured stage
  thresholds, supplied to you in the input; use "none" if no stage
  applies. Never invent a threshold that was not supplied to you.
- recommendedActions: 2-4 ranked interventions grounded in standard
  GRAP/CAQM playbooks (e.g. water sprinkling, construction pause,
  mechanized road sweeping, restricting non-essential diesel vehicles).
- publicAdvisory: one plain-language sentence safe to push to citizens
  in the affected corridor.
- citedSignals: list which specific input fields you relied on, for
  the audit trail an official may need to justify action taken.`;

export const DRAFT_ALERT_BRIEFING_FUNCTION = {
  name: 'draft_alert_briefing',
  description:
    'Produces a grounded, structured alert briefing for an official dashboard from pre-computed hotspot/forecast data.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      impliedGrapStage: { type: 'string', enum: ['none', 'stage_1', 'stage_2', 'stage_3', 'stage_4'] },
      recommendedActions: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
      publicAdvisory: { type: 'string' },
      citedSignals: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'description', 'impliedGrapStage', 'recommendedActions', 'publicAdvisory', 'citedSignals'],
  },
} as const;

/**
 * The structured, already-computed data Pipeline C receives. Shaped so the
 * field paths the model cites ("contributingSignals.satelliteAOD",
 * "horizons[1].predictedAQI", "corridor.grapThresholds") resolve against this
 * exact object -- which is what lets alert-service VERIFY every citation
 * instead of trusting it. `severity` is included as context, never asked of
 * the model (AI_PIPELINES.md: "we do not let the model decide how urgent its
 * own briefing is").
 */
export function buildPipelineCPayload(input: BriefingInput): Record<string, unknown> {
  const corridor = {
    id: input.corridor.id,
    name: input.corridor.name,
    states: input.corridor.states,
    grapFrameworkActive: input.corridor.grapFrameworkActive,
    // Omitted entirely when not configured: "Never invent a threshold that
    // was not supplied to you" is only enforceable if none is supplied.
    ...(input.corridor.grapFrameworkActive && input.corridor.grapThresholds
      ? { grapThresholds: input.corridor.grapThresholds }
      : {}),
  };

  if (input.kind === 'hotspot') {
    const { cell } = input;
    return {
      eventType: 'hotspot',
      severity: input.severity,
      h3Index: cell.h3Index,
      timestampHour: cell.timestampHour,
      hotspotConfidenceScore: cell.hotspotConfidenceScore,
      isHidden: cell.isHidden,
      classification: cell.classification,
      contributingSignals: cell.contributingSignals,
      jurisdiction: input.jurisdiction,
      corridor,
      history: input.history.map((h) => ({
        timestampHour: h.timestampHour,
        hotspotConfidenceScore: h.hotspotConfidenceScore,
        citizenReportCount: h.contributingSignals.citizenReportCount,
        ...(h.contributingSignals.satelliteAOD !== undefined ? { satelliteAOD: h.contributingSignals.satelliteAOD } : {}),
        ...(h.contributingSignals.fireDetectionCount !== undefined
          ? { fireDetectionCount: h.contributingSignals.fireDetectionCount }
          : {}),
      })),
    };
  }

  const { run } = input;
  return {
    eventType: 'forecast',
    severity: input.severity,
    forecastRunTimestamp: run.forecastRunTimestamp,
    horizons: run.horizons,
    keyDrivers: run.keyDrivers,
    // What alert-service computed from the thresholds above (context, so the
    // model's own mapping can be checked against it).
    computedGrapStage: input.impliedGrapStage,
    corridor,
    history: input.history.map((r) => ({
      forecastRunTimestamp: r.forecastRunTimestamp,
      maxPredictedAQI: Math.max(...r.horizons.map((h) => h.predictedAQI)),
    })),
  };
}

/**
 * Resolves "a.b[2].c" against an object. Returns undefined for any path that
 * doesn't exist -- i.e. a citation of data the model was never given.
 */
export function resolvePath(obj: unknown, path: string): unknown {
  if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*|\[\d+\])*$/.test(path)) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    // Own properties only: otherwise "constructor"/"toString" resolve through
    // the prototype chain and count as grounded citations.
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
