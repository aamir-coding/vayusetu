import {
  ASK_CLARIFYING_QUESTION,
  AskClarifyingQuestionSchema,
  buildPipelineAParts,
  callWithSchema,
  PIPELINE_A_SYSTEM_INSTRUCTION,
  PIPELINE_D_SYSTEM_INSTRUCTION,
  RECORD_AIR_QUALITY_ASSESSMENT,
  RecordAirQualityAssessmentSchema,
  type GenerativeModelTransport,
  type PipelineAInput,
} from '@vayusetu/gemini-client';
import type { TriageMode, TriageOutcome } from '../pipeline/analyze.js';

const SCHEMAS = {
  record_air_quality_assessment: RecordAirQualityAssessmentSchema,
  ask_clarifying_question: AskClarifyingQuestionSchema,
};

/** Pipeline A ('assess': one function) or Pipeline D ('clarify': assessment OR one question). */
/**
 * `timeoutMs` bounds each model call (retries included). Without it a hung
 * call could outlive the 120 s Pub/Sub ack deadline, so the message was
 * redelivered while the first attempt still ran: double Gemini spend and two
 * writers racing on analysisResults (audit H3). Up to 3 calls per report x
 * 25 s stays inside the deadline.
 */
export function createGeminiTriage(ai: GenerativeModelTransport, model: string, timeoutMs = 25_000) {
  return async (input: PipelineAInput, mode: TriageMode): Promise<TriageOutcome> => {
    const res = await callWithSchema({
      signal: AbortSignal.timeout(timeoutMs),
      ai,
      model,
      systemInstruction: mode === 'clarify' ? PIPELINE_D_SYSTEM_INSTRUCTION : PIPELINE_A_SYSTEM_INSTRUCTION,
      functions: mode === 'clarify' ? [RECORD_AIR_QUALITY_ASSESSMENT, ASK_CLARIFYING_QUESTION] : [RECORD_AIR_QUALITY_ASSESSMENT],
      parts: buildPipelineAParts(input),
      schemas: SCHEMAS,
    });
    if (!res.ok) return { kind: 'invalid', error: res.error, raw: { rawArgs: res.rawArgs, issues: res.issues } };
    const raw = { function: res.name, args: res.rawArgs, modelVersion: res.modelVersion };
    return res.data.name === 'ask_clarifying_question'
      ? { kind: 'question', value: res.data.value, modelVersion: res.modelVersion, raw }
      : { kind: 'assessment', value: res.data.value, modelVersion: res.modelVersion, raw };
  };
}
