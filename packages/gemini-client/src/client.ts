import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';

/**
 * The only part of the SDK the pipelines use. Typing against this instead
 * of GoogleGenAI lets tests pass a fake transport -- no GCP, no network.
 */
export interface GenerativeModelTransport {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
  };
}

export interface GeminiClientConfig {
  project: string;
  /**
   * Vertex AI location. As of 26 Sep 2026 the planned models answer only on
   * the `global` endpoint (asia-south1 returns 404 for gemini-3.7-flash and
   * gemini-3.1-pro-preview). Switch to an India region the day Model Garden
   * lists them there -- data residency for gov-facing, geolocated data.
   */
  location: string;
}

/** Vertex AI via Application Default Credentials (the service's own SA) -- no API key. */
export function createGeminiClient(config: GeminiClientConfig): GenerativeModelTransport {
  return new GoogleGenAI({ vertexai: true, project: config.project, location: config.location });
}

export interface GeminiModels {
  /** Pipelines A (triage) and D (clarification). */
  triage: string;
  /** Pipeline C (official briefing). */
  briefing: string;
}

/**
 * Model ids come from env so a GA release or a regional rollout is a config
 * change, not a deploy. Defaults are the ids verified callable on 26 Sep
 * 2026 (AI_PIPELINES.md names "Gemini 3.7 Flash" and "Gemini 3.1 Pro"; the
 * latter is still `-preview` on Vertex AI).
 */
export function resolveModels(env: Record<string, string | undefined> = process.env): GeminiModels {
  return {
    triage: env.GEMINI_TRIAGE_MODEL || 'gemini-3.7-flash',
    briefing: env.GEMINI_BRIEFING_MODEL || 'gemini-3.1-pro-preview',
  };
}

export function resolveLocation(env: Record<string, string | undefined> = process.env): string {
  return env.GEMINI_LOCATION || 'global';
}
