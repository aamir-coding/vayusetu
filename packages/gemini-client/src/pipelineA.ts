import type { Part } from '@google/genai';
import { z } from 'zod';
import type { PipelineFunctionDeclaration } from './functionCalling.js';

/**
 * Pipeline A -- Citizen Report Multimodal Triage (AI_PIPELINES.md).
 * System instruction and function declaration are VERBATIM from the doc; the
 * doc is canonical and this file is the one place code reads them from (the
 * ml/pipeline-a-eval harness and analysis-service both import it).
 */
export const PIPELINE_A_SYSTEM_INSTRUCTION = `You are the Environmental Field Analyst inside VayuSetu, an air-quality
early-warning system for Indian cities. A citizen has submitted a photo
(and optionally a short voice transcript) reporting something they
believe is affecting local air quality.

Your job: analyze the photo and any provided context, then call the
record_air_quality_assessment function with your structured findings.
Never respond in free text -- always respond via the function call.

Classification taxonomy (choose exactly one for sourceClassification):
- crop_residue_burning: open agricultural field burning, visible ash/stubble
- industrial_emission: smoke/plume from a factory stack or industrial unit
- open_waste_burning: burning garbage/plastic, typically roadside or dump sites
- vehicular_smog: haze consistent with traffic congestion, not a point source
- construction_dust: dust plumes from construction/demolition activity
- no_visible_pollution: clear sky, no evidence of the above
- indeterminate: image does not contain enough information to classify

Calibration rules:
1. Judge haze/opacity relative to what is visible in the background
   (buildings, horizon, sky). Backlit or golden-hour photos often look
   hazier than they are -- account for lighting before scoring severity.
2. If the photo is indoors, a close-up of an unrelated object, or
   otherwise not evidence of ambient outdoor air, classify as
   indeterminate and set confidenceScore below 0.3.
3. skyOpacityScore is 0 (crystal clear) to 1 (opaque / near-zero visibility).
4. visibilityMeters is your best estimate of how far a clear line of
   sight extends in the image; anchor the estimate against known
   reference objects (buildings, trees, road length) when present.
5. You are given the nearest official monitor's current AQI and the
   satellite aerosol index for this grid cell as CONTEXT ONLY -- use
   them to sanity-check, but classify primarily from what you see. If
   your visual assessment and the provided context disagree by more
   than two AQI categories, set needsHumanReview to true and explain
   why in reviewNote.
6. Never invent details not visible in the image. Prefer a lower
   confidenceScore over a confident-sounding guess.
7. Write recommendedAdvisory as one or two short, plain-language
   sentences a non-expert can act on immediately (e.g. "Avoid outdoor
   exercise near this location for the next few hours"), in the
   language given by advisoryLanguage.`;

export const POLLUTION_SOURCE_TYPES = [
  'crop_residue_burning',
  'industrial_emission',
  'open_waste_burning',
  'vehicular_smog',
  'construction_dust',
  'no_visible_pollution',
  'indeterminate',
] as const;

export const RECORD_AIR_QUALITY_ASSESSMENT: PipelineFunctionDeclaration = {
  name: 'record_air_quality_assessment',
  description: 'Records a structured environmental assessment of a citizen-submitted photo/voice report.',
  parameters: {
    type: 'object',
    properties: {
      sourceClassification: { type: 'string', enum: [...POLLUTION_SOURCE_TYPES] },
      severityEstimate: { type: 'integer', minimum: 1, maximum: 5 },
      skyOpacityScore: { type: 'number', minimum: 0, maximum: 1 },
      plumeDetected: { type: 'boolean' },
      visibilityMeters: { type: 'number', minimum: 0 },
      confidenceScore: { type: 'number', minimum: 0, maximum: 1 },
      needsHumanReview: { type: 'boolean' },
      reviewNote: { type: 'string' },
      recommendedAdvisory: { type: 'string' },
      advisoryLanguage: { type: 'string', description: 'BCP-47 tag, e.g. hi-IN, pa-IN, mr-IN, en-IN' },
    },
    required: [
      'sourceClassification',
      'severityEstimate',
      'skyOpacityScore',
      'plumeDetected',
      'confidenceScore',
      'needsHumanReview',
      'recommendedAdvisory',
      'advisoryLanguage',
    ],
  },
};

/** Server-side validator for the declaration above (field-for-field). */
export const RecordAirQualityAssessmentSchema = z.object({
  sourceClassification: z.enum(POLLUTION_SOURCE_TYPES),
  severityEstimate: z.number().int().min(1).max(5),
  skyOpacityScore: z.number().min(0).max(1),
  plumeDetected: z.boolean(),
  visibilityMeters: z.number().min(0).optional(),
  confidenceScore: z.number().min(0).max(1),
  needsHumanReview: z.boolean(),
  reviewNote: z.string().optional(),
  recommendedAdvisory: z.string().min(1).max(600),
  advisoryLanguage: z.string().min(2),
});
export type RecordAirQualityAssessment = z.infer<typeof RecordAirQualityAssessmentSchema>;

export interface PipelineAContext {
  nearestMonitor?: { id: string; aqi?: number; aqiCategory?: string; distanceKm: number; observedAt?: string };
  satellite?: { aerosolIndex?: number; aod550nm?: number; no2ColumnMolM2?: number; observationDate?: string };
  modeledAqi?: { aqi: number; category?: string; observedAt?: string };
  /** Local (IST) time of capture, e.g. "2026-11-03 07:40 IST". */
  localTime: string;
  season: string;
}

export interface ClarificationTurn {
  question: string;
  answerText?: string;
  /** An additional photo sent in reply, as a Gemini fileData part. */
  answerPhoto?: { gcsUri: string; mimeType: string };
}

export interface PipelineAInput {
  photo: { gcsUri: string; mimeType: string };
  transcript?: string;
  context: PipelineAContext;
  advisoryLanguage: string;
  /** Earlier Pipeline D turns (question + citizen answer), oldest first. */
  clarifications?: ClarificationTurn[];
}

/** Photo as a fileData part (gs:// URI -- the binary never transits Cloud Run) + a structured text block. */
export function buildPipelineAParts(input: PipelineAInput): Part[] {
  const ctx = input.context;
  const lines = [
    `advisoryLanguage: ${input.advisoryLanguage}`,
    `localTime: ${ctx.localTime}`,
    `season: ${ctx.season}`,
    ctx.nearestMonitor
      ? `nearestOfficialMonitor: id=${ctx.nearestMonitor.id}, distanceKm=${ctx.nearestMonitor.distanceKm.toFixed(1)}` +
        (ctx.nearestMonitor.aqi !== undefined
          ? `, currentAQI=${ctx.nearestMonitor.aqi} (${ctx.nearestMonitor.aqiCategory ?? 'unknown'}), observedAt=${ctx.nearestMonitor.observedAt ?? 'unknown'}`
          : ', currentAQI=unavailable')
      : 'nearestOfficialMonitor: none within range',
    ctx.satellite
      ? `satelliteAtCell: aerosolIndex=${ctx.satellite.aerosolIndex ?? 'n/a'}, aod550nm=${ctx.satellite.aod550nm ?? 'n/a'}, no2Column=${ctx.satellite.no2ColumnMolM2 ?? 'n/a'}, date=${ctx.satellite.observationDate ?? 'n/a'}`
      : 'satelliteAtCell: unavailable',
    ...(ctx.modeledAqi ? [`modeledAQIAtCell: ${ctx.modeledAqi.aqi} (${ctx.modeledAqi.category ?? 'unknown'})`] : []),
    input.transcript ? `voiceTranscript: ${JSON.stringify(input.transcript)}` : 'voiceTranscript: none',
  ];
  const parts: Part[] = [
    { fileData: { fileUri: input.photo.gcsUri, mimeType: input.photo.mimeType } },
    { text: `CONTEXT (reference only -- classify from the photo):\n${lines.join('\n')}` },
  ];
  for (const [i, turn] of (input.clarifications ?? []).entries()) {
    parts.push({
      text: `CLARIFICATION ${i + 1}: you asked ${JSON.stringify(turn.question)}; the citizen answered ${
        turn.answerText ? JSON.stringify(turn.answerText) : '(no text)'
      }${turn.answerPhoto ? ' and sent the additional photo below.' : '.'}`,
    });
    if (turn.answerPhoto) parts.push({ fileData: { fileUri: turn.answerPhoto.gcsUri, mimeType: turn.answerPhoto.mimeType } });
  }
  return parts;
}
