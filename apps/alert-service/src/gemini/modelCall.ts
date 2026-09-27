import {
  createGeminiClient,
  forcedFunctionCall,
  resolveLocation,
  resolveModels,
  type GenerativeModelTransport,
} from '@vayusetu/gemini-client';
import type { PipelineCModelCall } from './geminiBriefingGenerator.js';

export interface PipelineCModelCallOptions {
  project: string;
  /** Test hook: a fake transport instead of Vertex AI. */
  ai?: GenerativeModelTransport;
  env?: Record<string, string | undefined>;
}

/**
 * Pipeline C's model call (AI_PIPELINES.md): Gemini Pro on Vertex AI, forced
 * to call draft_alert_briefing, payload JSON as the single user turn.
 * Returns the function call's ARGS unvalidated -- geminiBriefingGenerator
 * owns validation, grounding checks and the template fallback.
 *
 * One retry at most: the caller's timeout (BRIEFING_TIMEOUT_MS) bounds the
 * whole thing and must stay under the push subscription's ack deadline.
 */
export function createPipelineCModelCall(opts: PipelineCModelCallOptions): PipelineCModelCall {
  const env = opts.env ?? process.env;
  const ai = opts.ai ?? createGeminiClient({ project: opts.project, location: resolveLocation(env) });
  const model = resolveModels(env).briefing;

  return async ({ systemInstruction, functionDeclaration, payload, signal }) => {
    const result = await forcedFunctionCall({
      ai,
      model,
      systemInstruction,
      functions: [functionDeclaration],
      parts: [{ text: JSON.stringify(payload) }],
      signal,
      retry: { maxRetries: 1 },
      temperature: 0.2,
    });
    return result.args;
  };
}
