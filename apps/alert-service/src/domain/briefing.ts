import { z } from 'zod';
import type {
  AlertSeverity,
  Corridor,
  ForecastHorizonPoint,
  ForecastRun,
  GRAPStage,
  HotspotCell,
  Jurisdiction,
} from '@vayusetu/shared-types';

/**
 * The Week 2 -> Week 3 seam. AI_PIPELINES.md Pipeline C's
 * `draft_alert_briefing` function schema, verbatim, as Zod. Engineer 3's
 * Gemini 3.1 Pro implementation (Week 3) must return exactly this shape;
 * the Week 2 template generator below is validated against the same schema,
 * so swapping one for the other cannot change what alert-service persists.
 * Note there is deliberately no `severity` here (see domain/severity.ts).
 */
export const AlertBriefingSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  impliedGrapStage: z.enum(['none', 'stage_1', 'stage_2', 'stage_3', 'stage_4']),
  recommendedActions: z.array(z.string().min(1)).min(2).max(4),
  publicAdvisory: z.string().min(1),
  citedSignals: z.array(z.string()),
});
export type AlertBriefing = z.infer<typeof AlertBriefingSchema>;

export type BriefingInput =
  | {
      kind: 'hotspot';
      cell: HotspotCell;
      corridor: Corridor;
      jurisdiction: Jurisdiction;
      severity: AlertSeverity;
    }
  | {
      kind: 'forecast';
      run: ForecastRun;
      corridor: Corridor;
      jurisdiction: Jurisdiction;
      severity: AlertSeverity;
      worst: ForecastHorizonPoint;
      impliedGrapStage: GRAPStage;
    };

export interface BriefingGenerator {
  readonly name: string;
  generate(input: BriefingInput): Promise<AlertBriefing>;
}

const SOURCE_LABEL: Record<HotspotCell['classification'], string> = {
  crop_residue_burning: 'crop residue burning',
  industrial_emission: 'industrial emissions',
  open_waste_burning: 'open waste burning',
  vehicular_smog: 'vehicular smog',
  construction_dust: 'construction dust',
  no_visible_pollution: 'unconfirmed pollution',
  indeterminate: 'unclassified pollution',
  mixed: 'mixed-source pollution',
  unknown: 'unclassified pollution',
};

/** Standard GRAP/CAQM-style field interventions, keyed by source. */
const HOTSPOT_ACTIONS: Record<HotspotCell['classification'], string[]> = {
  crop_residue_burning: ['Dispatch field team to verify active stubble fires', 'Alert upwind district/SPCB for coordinated enforcement'],
  industrial_emission: ['Dispatch SPCB inspection team to units in the cell', 'Verify emission-control equipment is operating'],
  open_waste_burning: ['Dispatch municipal team to extinguish and clear the site', 'Enforce the ban on open waste burning'],
  vehicular_smog: ['Deploy traffic police to decongest the corridor', 'Check for visibly polluting vehicles'],
  construction_dust: ['Inspect construction sites for dust-control compliance', 'Order water sprinkling on unpaved surfaces'],
  no_visible_pollution: ['Dispatch field team for ground verification', 'Cross-check the nearest official monitor'],
  indeterminate: ['Dispatch field team for ground verification', 'Cross-check the nearest official monitor'],
  mixed: ['Dispatch field team for ground verification', 'Order mechanized sweeping and water sprinkling'],
  unknown: ['Dispatch field team for ground verification', 'Cross-check the nearest official monitor'],
};

const GRAP_ACTIONS: Record<GRAPStage, string[]> = {
  none: ['Intensify mechanized road sweeping and water sprinkling', 'Enforce the ban on open waste burning'],
  stage_1: [
    'Enforce dust-control norms at construction sites',
    'Intensify mechanized road sweeping and water sprinkling',
    'Enforce the ban on open waste burning',
  ],
  stage_2: [
    'Pre-position anti-smog guns and sprinklers at known hotspots',
    'Increase public transport frequency',
    'Enforce dust-control norms at construction sites',
  ],
  stage_3: [
    'Restrict non-essential construction and demolition',
    'Restrict older petrol/diesel light vehicles per GRAP Stage III',
    'Intensify road sweeping and water sprinkling',
  ],
  stage_4: [
    'Stop entry of non-essential diesel trucks',
    'Halt construction on linear public projects',
    'Advise schools and offices on remote operation per GRAP Stage IV',
  ],
};

const STAGE_LABEL: Record<GRAPStage, string> = {
  none: 'no GRAP stage',
  stage_1: 'GRAP Stage I',
  stage_2: 'GRAP Stage II',
  stage_3: 'GRAP Stage III',
  stage_4: 'GRAP Stage IV',
};

function where(j: Jurisdiction, corridor: Corridor): string {
  return j.districtCode ? `${j.districtCode}, ${corridor.name}` : `${j.stateCode}, ${corridor.name}`;
}

/**
 * Week 2 stand-in for Pipeline C. Every sentence is built from fields that
 * are actually present in the input -- it follows Pipeline C's grounding
 * rule ("do not introduce facts ... not present in the input") by
 * construction, and cites exactly the fields it used.
 */
export const templateBriefingGenerator: BriefingGenerator = {
  name: 'template-v1',

  async generate(input: BriefingInput): Promise<AlertBriefing> {
    if (input.kind === 'hotspot') {
      const { cell, corridor, jurisdiction } = input;
      const s = cell.contributingSignals;
      const signals: string[] = [];
      const cited: string[] = ['hotspotConfidenceScore'];
      if (s.citizenReportCount > 0) {
        signals.push(
          `${s.citizenReportCount} citizen report(s)` +
            (s.avgCitizenSeverity !== undefined ? ` (avg severity ${s.avgCitizenSeverity.toFixed(1)}/5)` : ''),
        );
        cited.push('contributingSignals.citizenReportCount');
        if (s.avgCitizenSeverity !== undefined) cited.push('contributingSignals.avgCitizenSeverity');
      }
      if (s.satelliteAOD !== undefined) {
        signals.push(`satellite AOD ${s.satelliteAOD.toFixed(2)}`);
        cited.push('contributingSignals.satelliteAOD');
      }
      if (s.satelliteNO2 !== undefined) {
        signals.push(`satellite NO\u2082 column ${s.satelliteNO2}`);
        cited.push('contributingSignals.satelliteNO2');
      }
      if (s.fireDetectionCount) {
        signals.push(`${s.fireDetectionCount} satellite fire detection(s)`);
        cited.push('contributingSignals.fireDetectionCount');
      }
      if (s.nearestMonitorId && s.nearestMonitorDeltaAQI !== undefined) {
        signals.push(`monitor ${s.nearestMonitorId} ${s.nearestMonitorDeltaAQI >= 0 ? '+' : ''}${s.nearestMonitorDeltaAQI} AQI vs baseline`);
        cited.push('contributingSignals.nearestMonitorId', 'contributingSignals.nearestMonitorDeltaAQI');
      }
      if (cell.isHidden) cited.push('isHidden');

      const label = SOURCE_LABEL[cell.classification];
      const description = [
        `Fused hotspot confidence ${cell.hotspotConfidenceScore.toFixed(2)} for cell ${cell.h3Index} at ${cell.timestampHour}, classified as ${label}.`,
        signals.length ? `Signals: ${signals.join('; ')}.` : 'No individual contributing signals were reported for this cell.',
        cell.isHidden ? 'No official monitor lies within the configured radius of this cell.' : '',
      ]
        .filter(Boolean)
        .join(' ');

      return AlertBriefingSchema.parse({
        title: `${cell.isHidden ? 'Hidden hotspot' : 'Hotspot'}: ${label}, ${where(jurisdiction, corridor)}`,
        description,
        impliedGrapStage: 'none', // a confidence score is not an AQI; the template won't infer a stage
        recommendedActions: HOTSPOT_ACTIONS[cell.classification],
        publicAdvisory: 'Air quality may be poor near this area; limit prolonged outdoor activity until it clears.',
        citedSignals: cited,
      });
    }

    const { run, corridor, jurisdiction, worst, impliedGrapStage } = input;
    const idx = run.horizons.indexOf(worst);
    const cited = [`horizons[${idx}].predictedAQI`, `horizons[${idx}].predictedAQICategory`];
    if (run.keyDrivers.length) cited.push('keyDrivers');
    if (impliedGrapStage !== 'none') cited.push('corridor.grapThresholds');

    const description = [
      `Forecast run ${run.forecastRunTimestamp} predicts AQI ${worst.predictedAQI} (${worst.predictedAQICategory.replace('_', ' ')}) within ${worst.horizonHours} hours` +
        ` (interval ${worst.confidenceInterval.lower}\u2013${worst.confidenceInterval.upper}), mapping to ${STAGE_LABEL[impliedGrapStage]}.`,
      run.keyDrivers.length ? `Key drivers: ${run.keyDrivers.join('; ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');

    return AlertBriefingSchema.parse({
      title: `${worst.horizonHours}h forecast: AQI ${worst.predictedAQI}, ${STAGE_LABEL[impliedGrapStage]}, ${where(jurisdiction, corridor)}`,
      description,
      impliedGrapStage,
      recommendedActions: GRAP_ACTIONS[impliedGrapStage],
      publicAdvisory: `Air quality is expected to reach ${worst.predictedAQICategory.replace('_', ' ')} levels within ${worst.horizonHours} hours; sensitive groups should plan to limit outdoor exposure.`,
      citedSignals: cited,
    });
  },
};
