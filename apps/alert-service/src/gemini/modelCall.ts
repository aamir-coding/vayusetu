import type { PipelineCModelCall } from './geminiBriefingGenerator.js';

/**
 * ENGINEER 3 -- your Week 3 deliverable "Pipeline C implemented, wired into
 * alert-service" is the body of this ONE function, using
 * @vayusetu/gemini-client (Gemini 3.1 Pro). Contract (see PipelineCModelCall):
 *   - systemInstruction  -> the model's system instruction
 *   - functionDeclaration -> the single tool; force the call (mode ANY)
 *   - payload            -> JSON.stringify'd as the user turn
 *   - signal             -> abort the request on timeout
 *   - return             -> the function call's ARGS object, unvalidated
 * Everything else (timeout, schema validation, grounding guards, template
 * fallback, logging) is alert-service's and already tested.
 *
 * Until then, BRIEFING_GENERATOR=gemini makes the service refuse to boot --
 * deliberately loud at deploy time instead of silent at the first alert.
 */
export function createPipelineCModelCall(): PipelineCModelCall {
  throw new Error(
    'Pipeline C model call is not implemented yet (apps/alert-service/src/gemini/modelCall.ts, Engineer 3). ' +
      'Run with BRIEFING_GENERATOR=template until it lands.',
  );
}
