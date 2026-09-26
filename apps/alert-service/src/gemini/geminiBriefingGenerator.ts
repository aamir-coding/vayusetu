import { AlertBriefingSchema, type AlertBriefing, type BriefingGenerator, type BriefingInput } from '../domain/briefing.js';
import {
  DRAFT_ALERT_BRIEFING_FUNCTION,
  PIPELINE_C_SYSTEM_INSTRUCTION,
  buildPipelineCPayload,
  resolvePath,
} from './briefingPrompt.js';

/**
 * THE Week 3 integration point with Engineer 3 (Pipeline C owner). Implement
 * with @vayusetu/gemini-client: send the system instruction + the one
 * function declaration + the payload (as the user turn, JSON), force the
 * function call, return its ARGS object. Don't validate here -- this module
 * does that. Honour `signal` so a timeout actually cancels the request.
 */
export type PipelineCModelCall = (request: {
  systemInstruction: string;
  functionDeclaration: typeof DRAFT_ALERT_BRIEFING_FUNCTION;
  payload: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<unknown>;

export type BriefingOutcome =
  | 'gemini'
  | 'gemini_repaired'
  | 'fallback_timeout'
  | 'fallback_model_error'
  | 'fallback_schema_violation';

export interface GeminiBriefingOptions {
  callModel: PipelineCModelCall;
  /** Grounded, deterministic generator used when the model can't be trusted. */
  fallback: BriefingGenerator;
  timeoutMs: number;
  logger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  /** Test hook: observe each outcome (production reads the logs/metrics). */
  onOutcome?: (outcome: BriefingOutcome, detail: Record<string, unknown>) => void;
}

const MAX_TITLE_WORDS = 12;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Every number appearing anywhere in the payload, stringified at 0-2 dp. */
function payloadNumbers(obj: unknown, out = new Set<string>()): Set<string> {
  if (typeof obj === 'number') {
    for (const dp of [0, 1, 2]) out.add(obj.toFixed(dp));
    out.add(String(obj));
  } else if (typeof obj === 'string') {
    // numbers embedded in strings (timestamps, keyDrivers text, h3 digits)
    for (const m of obj.match(/\d+(\.\d+)?/g) ?? []) out.add(m);
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) payloadNumbers(v, out);
  }
  return out;
}

function sourceRef(input: BriefingInput): string {
  return input.kind === 'hotspot' ? input.cell.id : input.run.id;
}

/**
 * Wraps the model call so its output is treated as UNTRUSTED INPUT:
 *
 *  1. Timeout / model error / 429          -> template fallback. The alert must
 *     not wait on Gemini: a plainer briefing now beats a richer one after the
 *     Pub/Sub backoff, and ids are deterministic so there is no "later".
 *  2. Fails the draft_alert_briefing schema -> template fallback.
 *  3. Field-level guards with deterministic repairs (logged as gemini_repaired):
 *     - impliedGrapStage must equal what the corridor's configured thresholds
 *       imply (forecast) or 'none' (hotspot: a confidence score is not an AQI;
 *       non-GRAP corridor: no thresholds were supplied) -- enforces "never
 *       invent a threshold".
 *     - citedSignals must resolve against the payload; ungrounded citations
 *       are dropped (audit trail must point at real inputs).
 *     - title over 12 words -> the template's title.
 *  4. Numbers in title/description absent from the payload are LOGGED, not
 *     rejected: legitimate derived figures ("4x", "2.1x median") would trip a
 *     hard check. The log line is the signal for Engineer 3's prompt tuning.
 */
export function createGeminiBriefingGenerator(opts: GeminiBriefingOptions): BriefingGenerator {
  const record = (outcome: BriefingOutcome, input: BriefingInput, detail: Record<string, unknown> = {}) => {
    const entry = { outcome, kind: input.kind, sourceRef: sourceRef(input), ...detail };
    if (outcome.startsWith('fallback')) opts.logger.warn(entry, 'Pipeline C briefing fell back to template');
    else opts.logger.info(entry, 'Pipeline C briefing');
    opts.onOutcome?.(outcome, entry);
  };

  return {
    name: 'gemini-pipeline-c',

    async generate(input: BriefingInput): Promise<AlertBriefing> {
      const payload = buildPipelineCPayload(input);
      const controller = new AbortController();
      // Timed-out-ness is a FLAG set by the timer, checked after the await
      // however the call settled -- not inferred from Promise.race ordering,
      // which a client that settles on abort can win with a late answer.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, opts.timeoutMs);

      let raw: unknown;
      try {
        raw = await Promise.race([
          opts.callModel({
            systemInstruction: PIPELINE_C_SYSTEM_INSTRUCTION,
            functionDeclaration: DRAFT_ALERT_BRIEFING_FUNCTION,
            payload,
            signal: controller.signal,
          }),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener('abort', () => reject(new Error('__pipeline_c_timeout__'))),
          ),
        ]);
      } catch (error) {
        if (!timedOut) {
          record('fallback_model_error', input, { error: (error as Error).message });
          return opts.fallback.generate(input);
        }
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) {
        record('fallback_timeout', input, { timeoutMs: opts.timeoutMs });
        return opts.fallback.generate(input);
      }

      const parsed = AlertBriefingSchema.safeParse(raw);
      if (!parsed.success) {
        record('fallback_schema_violation', input, {
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        return opts.fallback.generate(input);
      }

      const briefing = { ...parsed.data };
      const repairs: string[] = [];

      // -- impliedGrapStage: deterministic, never the model's to invent
      const expectedStage = input.kind === 'forecast' ? input.impliedGrapStage : 'none';
      if (briefing.impliedGrapStage !== expectedStage) {
        repairs.push(`impliedGrapStage ${briefing.impliedGrapStage}->${expectedStage}`);
        briefing.impliedGrapStage = expectedStage;
      }

      // -- citations must point at data the model was actually given
      const grounded = briefing.citedSignals.filter((p) => resolvePath(payload, p) !== undefined);
      const ungrounded = briefing.citedSignals.filter((p) => !grounded.includes(p));
      if (ungrounded.length > 0) repairs.push(`dropped citations: ${ungrounded.join(', ')}`);
      briefing.citedSignals = grounded;

      // -- title length (Pipeline C: <= 12 words)
      if (wordCount(briefing.title) > MAX_TITLE_WORDS) {
        repairs.push(`title ${wordCount(briefing.title)} words`);
        briefing.title = (await opts.fallback.generate(input)).title;
      }
      if (briefing.citedSignals.length === 0) {
        repairs.push('no grounded citations; used template citations');
        briefing.citedSignals = (await opts.fallback.generate(input)).citedSignals;
      }

      // -- numeric grounding: observe, don't block
      const known = payloadNumbers(payload);
      const ungroundedNumbers = [...`${briefing.title} ${briefing.description}`.matchAll(/\d+(\.\d+)?/g)]
        .map((m) => m[0])
        .filter((n) => !known.has(n));

      record(repairs.length ? 'gemini_repaired' : 'gemini', input, {
        ...(repairs.length ? { repairs } : {}),
        ...(ungroundedNumbers.length ? { ungroundedNumbers } : {}),
      });
      return AlertBriefingSchema.parse(briefing);
    },
  };
}
