import { describe, expect, it, vi } from 'vitest';
import type { Corridor, ForecastRun, HotspotCell } from '@vayusetu/shared-types';
import { AlertBriefingSchema, type BriefingInput, templateBriefingGenerator } from '../src/domain/briefing.js';
import { assessForecast } from '../src/domain/severity.js';
import {
  DRAFT_ALERT_BRIEFING_FUNCTION,
  PIPELINE_C_SYSTEM_INSTRUCTION,
  buildPipelineCPayload,
  resolvePath,
} from '../src/gemini/briefingPrompt.js';
import {
  type BriefingOutcome,
  type PipelineCModelCall,
  createGeminiBriefingGenerator,
} from '../src/gemini/geminiBriefingGenerator.js';

const NCR: Corridor = {
  id: 'ncr-airshed', name: 'Delhi-NCR Airshed', states: ['DL', 'HR', 'UP', 'RJ'],
  boundaryGeoJsonStorageUrl: 'gs://x', population: 1, monitoringStationIds: [], grapFrameworkActive: true,
  grapThresholds: {
    stage_1: { aqiMin: 201, aqiMax: 300 }, stage_2: { aqiMin: 301, aqiMax: 400 },
    stage_3: { aqiMin: 401, aqiMax: 450 }, stage_4: { aqiMin: 451, aqiMax: 500 },
  },
  createdAt: '2026-01-01T00:00:00.000Z',
};
const MUMBAI: Corridor = { ...NCR, id: 'mumbai-pune-corridor', name: 'Mumbai\u2013Pune Corridor', states: ['MH'], grapFrameworkActive: false, grapThresholds: undefined };

const cell: HotspotCell = {
  id: '881f1d4a5bfffff_2026-09-24T06', h3Index: '881f1d4a5bfffff', corridorId: 'ncr-airshed',
  timestampHour: '2026-09-24T06:00:00.000Z', hotspotConfidenceScore: 0.92, isHidden: true,
  classification: 'open_waste_burning',
  contributingSignals: { citizenReportCount: 14, avgCitizenSeverity: 4.2, satelliteAOD: 0.61 },
  modelVersion: 'hs-v2', createdAt: '2026-09-24T06:05:00.000Z',
};
const hotspotInput: BriefingInput = {
  kind: 'hotspot', cell, corridor: NCR, jurisdiction: { stateCode: 'DL', districtCode: 'DL-CENTRAL' }, severity: 'critical',
  history: [{ ...cell, id: 'prev', timestampHour: '2026-09-24T05:00:00.000Z', hotspotConfidenceScore: 0.71,
    contributingSignals: { citizenReportCount: 3 } }],
};

function forecastInput(corridor: Corridor): BriefingInput {
  const run: ForecastRun = {
    id: `${corridor.id}_2026-09-24T00`, corridorId: corridor.id, forecastRunTimestamp: '2026-09-24T00:00:00.000Z',
    horizons: [24, 48, 72].map((h, i) => ({
      horizonHours: h as 24 | 48 | 72, predictedAQI: [290, 420, 380][i]!, predictedAQICategory: 'severe',
      predictedGRAPStage: 'none', confidenceInterval: { lower: 0, upper: 500 },
    })),
    keyDrivers: ['upwind stubble fires'], modelVersion: 'fc-v1', createdAt: '2026-09-24T00:05:00.000Z',
  };
  const a = assessForecast(run, corridor)!;
  return { kind: 'forecast', run, corridor, severity: a.severity ?? 'watch', worst: a.worst, impliedGrapStage: a.impliedGrapStage, history: [] };
}

/** A well-behaved Gemini answer for the hotspot input. */
const goodHotspotAnswer = {
  title: 'Hidden waste-burning hotspot in Central Delhi',
  description: 'Fused confidence 0.92 with 14 citizen reports (avg severity 4.2) and satellite AOD 0.61. No official monitor nearby.',
  impliedGrapStage: 'none',
  recommendedActions: ['Dispatch municipal team to extinguish the fire', 'Enforce the open-burning ban'],
  publicAdvisory: 'Avoid the area and keep windows closed until smoke clears.',
  citedSignals: ['hotspotConfidenceScore', 'contributingSignals.citizenReportCount', 'contributingSignals.satelliteAOD', 'isHidden'],
};

function harness(callModel: PipelineCModelCall, timeoutMs = 1000) {
  const outcomes: Array<{ outcome: BriefingOutcome; detail: Record<string, unknown> }> = [];
  const gen = createGeminiBriefingGenerator({
    callModel,
    fallback: templateBriefingGenerator,
    timeoutMs,
    logger: { info: () => {}, warn: () => {} },
    onOutcome: (outcome, detail) => outcomes.push({ outcome, detail }),
  });
  return { gen, outcomes };
}

describe('Pipeline C prompt + payload', () => {
  it('pins the verbatim contract: instruction rules and required fields match AlertBriefingSchema', () => {
    for (const phrase of ['Never invent a threshold', 'never respond in free text', '<= 12 words', 'citedSignals']) {
      expect(PIPELINE_C_SYSTEM_INSTRUCTION).toContain(phrase);
    }
    expect([...DRAFT_ALERT_BRIEFING_FUNCTION.parameters.required].sort()).toEqual(Object.keys(AlertBriefingSchema.shape).sort());
    expect(DRAFT_ALERT_BRIEFING_FUNCTION.parameters.properties).not.toHaveProperty('severity'); // AI_PIPELINES.md: deliberate
  });

  it('every citation the TEMPLATE makes resolves against the payload (the guard and template agree)', async () => {
    for (const input of [hotspotInput, forecastInput(NCR), forecastInput(MUMBAI)]) {
      const payload = buildPipelineCPayload(input);
      for (const path of (await templateBriefingGenerator.generate(input)).citedSignals) {
        expect(resolvePath(payload, path), `${input.kind}: ${path}`).not.toBeUndefined();
      }
    }
  });

  it('supplies grapThresholds only when the corridor has them, and passes history + severity as context', () => {
    expect(resolvePath(buildPipelineCPayload(forecastInput(NCR)), 'corridor.grapThresholds')).toBeDefined();
    expect(resolvePath(buildPipelineCPayload(forecastInput(MUMBAI)), 'corridor.grapThresholds')).toBeUndefined();
    const p = buildPipelineCPayload(hotspotInput);
    expect(resolvePath(p, 'history[0].hotspotConfidenceScore')).toBe(0.71);
    expect(p.severity).toBe('critical');
  });

  it('resolvePath rejects anything that is not a plain field path', () => {
    const p = { a: { b: [{ c: 1 }] } };
    expect(resolvePath(p, 'a.b[0].c')).toBe(1);
    for (const bad of ['a.b[0].d', 'constructor', '__proto__.x', 'a..b', '$.a', 'a.b[x]']) {
      expect(resolvePath(p, bad), bad).toBeUndefined();
    }
  });
});

describe('Gemini briefing generator -- model output is untrusted input', () => {
  it('passes a grounded, valid answer through unchanged and sends the verbatim prompt + payload', async () => {
    const callModel = vi.fn<PipelineCModelCall>(async () => goodHotspotAnswer);
    const { gen, outcomes } = harness(callModel);
    expect(await gen.generate(hotspotInput)).toEqual(goodHotspotAnswer);
    expect(outcomes.map((o) => o.outcome)).toEqual(['gemini']);
    const req = callModel.mock.calls[0]![0];
    expect(req.systemInstruction).toBe(PIPELINE_C_SYSTEM_INSTRUCTION);
    expect(req.payload).toEqual(buildPipelineCPayload(hotspotInput));
  });

  it('falls back to the template on a schema violation (5 actions, missing field)', async () => {
    const template = await templateBriefingGenerator.generate(hotspotInput);
    for (const bad of [
      { ...goodHotspotAnswer, recommendedActions: ['a', 'b', 'c', 'd', 'e'] },
      { ...goodHotspotAnswer, publicAdvisory: undefined },
      'plain text instead of a function call',
    ]) {
      const { gen, outcomes } = harness(async () => bad);
      expect(await gen.generate(hotspotInput)).toEqual(template);
      expect(outcomes[0]!.outcome).toBe('fallback_schema_violation');
    }
  });

  it('times out, aborts the in-flight request, and falls back -- a hung model never delays an alert', async () => {
    let aborted = false;
    const { gen, outcomes } = harness(
      ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(goodHotspotAnswer); })),
      30,
    );
    expect(await gen.generate(hotspotInput)).toEqual(await templateBriefingGenerator.generate(hotspotInput));
    expect(outcomes[0]!.outcome).toBe('fallback_timeout');
    expect(aborted).toBe(true);
  });

  it('falls back on a model error (429 / 5xx)', async () => {
    const { gen, outcomes } = harness(async () => { throw new Error('429 RESOURCE_EXHAUSTED'); });
    await gen.generate(hotspotInput);
    expect(outcomes[0]).toMatchObject({ outcome: 'fallback_model_error', detail: { error: '429 RESOURCE_EXHAUSTED' } });
  });

  it('overrides an invented GRAP stage: forecast -> computed stage; hotspot / non-GRAP corridor -> none', async () => {
    const answer = { ...goodHotspotAnswer, impliedGrapStage: 'stage_4', citedSignals: ['keyDrivers'] };
    const ncr = await harness(async () => answer).gen.generate(forecastInput(NCR));
    expect(ncr.impliedGrapStage).toBe('stage_3'); // AQI 420 against NCR thresholds
    const mumbai = await harness(async () => answer).gen.generate(forecastInput(MUMBAI));
    expect(mumbai.impliedGrapStage).toBe('none'); // no thresholds were supplied
    const { gen, outcomes } = harness(async () => ({ ...goodHotspotAnswer, impliedGrapStage: 'stage_2' }));
    expect((await gen.generate(hotspotInput)).impliedGrapStage).toBe('none'); // a confidence score is not an AQI
    expect(outcomes[0]!.outcome).toBe('gemini_repaired');
  });

  it('drops citations of data the model was never given; all-ungrounded -> template citations', async () => {
    const partly = await harness(async () => ({
      ...goodHotspotAnswer,
      citedSignals: ['contributingSignals.satelliteAOD', 'contributingSignals.pm25', 'windSpeed'],
    })).gen.generate(hotspotInput);
    expect(partly.citedSignals).toEqual(['contributingSignals.satelliteAOD']);

    const none = await harness(async () => ({ ...goodHotspotAnswer, citedSignals: ['madeUp'] })).gen.generate(hotspotInput);
    expect(none.citedSignals).toEqual((await templateBriefingGenerator.generate(hotspotInput)).citedSignals);
  });

  it('replaces an over-long title with the template title, keeping the rest of the model output', async () => {
    const long = 'Severe and worsening open waste burning hotspot detected today in the Central Delhi district area';
    const out = await harness(async () => ({ ...goodHotspotAnswer, title: long })).gen.generate(hotspotInput);
    expect(out.title).toBe((await templateBriefingGenerator.generate(hotspotInput)).title);
    expect(out.description).toBe(goodHotspotAnswer.description);
  });

  it('logs (but does not reject) numbers that appear nowhere in the input', async () => {
    const { gen, outcomes } = harness(async () => ({
      ...goodHotspotAnswer,
      description: 'Fused confidence 0.92; reports up 37x; PM2.5 at 612 ug/m3.',
    }));
    await gen.generate(hotspotInput);
    expect(outcomes[0]!.outcome).toBe('gemini');
    expect(outcomes[0]!.detail.ungroundedNumbers).toEqual(expect.arrayContaining(['37', '612']));
    expect(outcomes[0]!.detail.ungroundedNumbers).not.toContain('0.92');
  });
});
