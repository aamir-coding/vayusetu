import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import {
  ASK_CLARIFYING_QUESTION,
  AskClarifyingQuestionSchema,
  PIPELINE_A_SYSTEM_INSTRUCTION,
  RECORD_AIR_QUALITY_ASSESSMENT,
  RecordAirQualityAssessmentSchema,
  buildPipelineAParts,
  callWithSchema,
  forcedFunctionCall,
  isRetryableError,
  resolveModels,
  withRetry,
  type GenerativeModelTransport,
} from '../src/index.js';

// Normalized: core.autocrlf checkouts on Windows turn the doc into CRLF.
const DOC = readFileSync(new URL('../../../docs/context/05_AI_PIPELINES.md', import.meta.url), 'utf-8').replace(/\r\n/g, '\n');

function fakeTransport(...responses: Array<Partial<GenerateContentResponse> | Error>) {
  const calls: GenerateContentParameters[] = [];
  const ai: GenerativeModelTransport = {
    models: {
      generateContent: vi.fn(async (params: GenerateContentParameters) => {
        calls.push(params);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next as GenerateContentResponse;
      }),
    },
  };
  return { ai, calls };
}

const validArgs = {
  sourceClassification: 'vehicular_smog',
  severityEstimate: 3,
  skyOpacityScore: 0.6,
  plumeDetected: false,
  confidenceScore: 0.8,
  needsHumanReview: false,
  recommendedAdvisory: 'बाहर व्यायाम से बचें।',
  advisoryLanguage: 'hi-IN',
};

const baseReq = (ai: GenerativeModelTransport) => ({
  ai,
  model: 'gemini-3.7-flash',
  systemInstruction: PIPELINE_A_SYSTEM_INSTRUCTION,
  functions: [RECORD_AIR_QUALITY_ASSESSMENT],
  parts: [{ text: 'x' }],
  retry: { sleep: async () => undefined },
});

describe('AI_PIPELINES.md is the canonical source', () => {
  it('Pipeline A system instruction is verbatim', () => {
    const block = DOC.split('**System instruction:**')[1]!.split('```text')[1]!.split('```')[0]!.trim();
    expect(PIPELINE_A_SYSTEM_INSTRUCTION).toBe(block);
  });

  it('record_air_quality_assessment declaration is verbatim', () => {
    const json = DOC.split('**Function calling schema:**')[1]!.split('```json')[1]!.split('```')[0]!;
    expect(RECORD_AIR_QUALITY_ASSESSMENT).toEqual(JSON.parse(json));
  });

  it('Zod validator requires exactly the declaration\'s required fields', () => {
    const shape = RecordAirQualityAssessmentSchema.shape;
    const zodRequired = Object.entries(shape).filter(([, s]) => !s.isOptional()).map(([k]) => k).sort();
    expect(zodRequired).toEqual([...(RECORD_AIR_QUALITY_ASSESSMENT.parameters.required as string[])].sort());
    expect(Object.keys(shape).sort()).toEqual(
      Object.keys(RECORD_AIR_QUALITY_ASSESSMENT.parameters.properties as object).sort(),
    );
  });
});

describe('forcedFunctionCall', () => {
  it('forces mode ANY restricted to the declared functions', async () => {
    const { ai, calls } = fakeTransport({ functionCalls: [{ name: 'record_air_quality_assessment', args: validArgs }], modelVersion: 'gemini-3.7-flash-001' });
    const res = await forcedFunctionCall(baseReq(ai));
    const cfg = calls[0]!.config!;
    expect(cfg.toolConfig?.functionCallingConfig?.mode).toBe('ANY');
    expect(cfg.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual(['record_air_quality_assessment']);
    expect(cfg.tools?.[0]).toMatchObject({ functionDeclarations: [{ name: 'record_air_quality_assessment' }] });
    expect(res).toEqual({ name: 'record_air_quality_assessment', args: validArgs, modelVersion: 'gemini-3.7-flash-001' });
  });

  it('rejects free text / a function that was not allowed', async () => {
    const { ai } = fakeTransport({ functionCalls: [{ name: 'delete_everything', args: {} }] });
    await expect(forcedFunctionCall(baseReq(ai))).rejects.toThrow('allowed function');
  });

  it('retries 429 then succeeds; never retries a 400', async () => {
    const e429 = Object.assign(new Error('quota'), { status: 429 });
    const ok = { functionCalls: [{ name: 'record_air_quality_assessment', args: validArgs }] };
    const a = fakeTransport(e429, ok);
    await expect(forcedFunctionCall(baseReq(a.ai))).resolves.toMatchObject({ name: 'record_air_quality_assessment' });
    expect(a.calls).toHaveLength(2);

    const b = fakeTransport(Object.assign(new Error('bad schema'), { status: 400 }), ok);
    await expect(forcedFunctionCall(baseReq(b.ai))).rejects.toThrow('bad schema');
    expect(b.calls).toHaveLength(1);
  });

  it('passes the abort signal through and does not retry after abort', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { ai, calls } = fakeTransport(abortErr, { functionCalls: [] });
    await expect(forcedFunctionCall({ ...baseReq(ai), signal: ctrl.signal })).rejects.toThrow('aborted');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config!.abortSignal).toBe(ctrl.signal);
  });
});

describe('callWithSchema', () => {
  const schemas = { record_air_quality_assessment: RecordAirQualityAssessmentSchema, ask_clarifying_question: AskClarifyingQuestionSchema };

  it('validates per returned function', async () => {
    const { ai } = fakeTransport({ functionCalls: [{ name: 'ask_clarifying_question', args: { question: 'क्या धुआँ खेत से आ रहा है?', language: 'hi-IN' } }] });
    const res = await callWithSchema({ ...baseReq(ai), functions: [RECORD_AIR_QUALITY_ASSESSMENT, ASK_CLARIFYING_QUESTION], schemas });
    expect(res.ok && res.data.name).toBe('ask_clarifying_question');
  });

  it('reports schema violations instead of throwing (caller falls back)', async () => {
    const { ai } = fakeTransport({ functionCalls: [{ name: 'record_air_quality_assessment', args: { ...validArgs, severityEstimate: 9 } }] });
    const res = await callWithSchema({ ...baseReq(ai), schemas });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues?.[0]?.path).toEqual(['severityEstimate']);
  });

  it('reports a missing function call as a contract failure', async () => {
    const { ai } = fakeTransport({ functionCalls: undefined });
    const res = await callWithSchema({ ...baseReq(ai), schemas });
    expect(res).toMatchObject({ ok: false });
  });
});

describe('helpers', () => {
  it('builds Pipeline A parts: gs:// fileData + context block + clarification turns', () => {
    const parts = buildPipelineAParts({
      photo: { gcsUri: 'gs://b/submissions/u/p.jpg', mimeType: 'image/jpeg' },
      transcript: 'धुआँ बहुत है',
      advisoryLanguage: 'hi-IN',
      context: {
        localTime: '2026-11-03 07:40 IST',
        season: 'post-monsoon (crop-burning window)',
        nearestMonitor: { id: 'anand-vihar', aqi: 412, aqiCategory: 'severe', distanceKm: 2.34 },
      },
      clarifications: [{ question: 'Is it a field?', answerText: 'yes', answerPhoto: { gcsUri: 'gs://b/2.jpg', mimeType: 'image/jpeg' } }],
    });
    expect(parts[0]).toEqual({ fileData: { fileUri: 'gs://b/submissions/u/p.jpg', mimeType: 'image/jpeg' } });
    expect(parts[1]!.text).toContain('currentAQI=412 (severe)');
    expect(parts[1]!.text).toContain('distanceKm=2.3');
    expect(parts[2]!.text).toContain('CLARIFICATION 1');
    expect(parts[3]).toEqual({ fileData: { fileUri: 'gs://b/2.jpg', mimeType: 'image/jpeg' } });
  });

  it('model ids and retryability', () => {
    expect(resolveModels({})).toEqual({ triage: 'gemini-3.7-flash', briefing: 'gemini-3.1-pro-preview' });
    expect(resolveModels({ GEMINI_BRIEFING_MODEL: 'gemini-3.1-pro' }).briefing).toBe('gemini-3.1-pro');
    expect(isRetryableError(Object.assign(new Error(), { status: 503 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error(), { status: 403 }))).toBe(false);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
  });

  it('withRetry gives up after maxRetries', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('busy'), { status: 503 });
    });
    await expect(withRetry(fn, { maxRetries: 2, sleep: async () => undefined })).rejects.toThrow('busy');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
