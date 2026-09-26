import { FunctionCallingConfigMode, type FunctionDeclaration, type Part } from '@google/genai';
import type { z } from 'zod';
import type { GenerativeModelTransport } from './client.js';
import { withRetry, type RetryOptions } from './retry.js';

/** A declaration exactly as written in AI_PIPELINES.md (JSON Schema `parameters`). */
export interface PipelineFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ForcedCallRequest {
  ai: GenerativeModelTransport;
  model: string;
  systemInstruction: string;
  /** One or more allowed functions; the model MUST call one of them (mode ANY). */
  functions: PipelineFunctionDeclaration[];
  parts: Part[];
  signal?: AbortSignal;
  retry?: Omit<RetryOptions, 'signal'>;
  temperature?: number;
}

export interface ForcedCallResult {
  name: string;
  /** UNVALIDATED model output -- treat as untrusted input. */
  args: unknown;
  /** Version string reported by Vertex AI, else the requested id. */
  modelVersion: string;
}

export class ModelContractError extends Error {
  constructor(
    message: string,
    public readonly detail: unknown,
  ) {
    super(message);
    this.name = 'ModelContractError';
  }
}

/**
 * Every pipeline "never responds in free text" (AI_PIPELINES.md): the call
 * is forced (FunctionCallingConfigMode.ANY) and restricted to the pipeline's
 * declared functions. Returns the raw arguments; validation is the caller's
 * job (see callWithSchema) because only the caller knows its contract.
 */
export async function forcedFunctionCall(req: ForcedCallRequest): Promise<ForcedCallResult> {
  const declarations: FunctionDeclaration[] = req.functions.map((f) => ({
    name: f.name,
    description: f.description,
    parametersJsonSchema: f.parameters,
  }));
  const response = await withRetry(
    () =>
      req.ai.models.generateContent({
        model: req.model,
        contents: [{ role: 'user', parts: req.parts }],
        config: {
          systemInstruction: req.systemInstruction,
          temperature: req.temperature ?? 0.2,
          tools: [{ functionDeclarations: declarations }],
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: req.functions.map((f) => f.name),
            },
          },
          ...(req.signal ? { abortSignal: req.signal } : {}),
        },
      }),
    { ...req.retry, signal: req.signal },
  );
  const call = response.functionCalls?.[0];
  if (!call?.name || !req.functions.some((f) => f.name === call.name)) {
    throw new ModelContractError('Model did not return one of the allowed function calls', {
      functionCalls: response.functionCalls ?? null,
      finishReason: response.candidates?.[0]?.finishReason,
    });
  }
  return { name: call.name, args: call.args ?? {}, modelVersion: response.modelVersion || req.model };
}

export type ValidatedCall<T> =
  | { ok: true; data: T; name: string; rawArgs: unknown; modelVersion: string }
  | { ok: false; error: string; name?: string; rawArgs: unknown; issues?: z.ZodIssue[]; modelVersion?: string };

/**
 * forcedFunctionCall + server-side Zod validation per function name
 * ("never trust the model's structural compliance blindly").
 * Transport/HTTP failures still throw; contract failures return ok:false so
 * the caller can take its documented fallback path.
 */
export async function callWithSchema<S extends Record<string, z.ZodTypeAny>>(
  req: ForcedCallRequest & { schemas: S },
): Promise<ValidatedCall<{ [K in keyof S]: { name: K; value: z.infer<S[K]> } }[keyof S]>> {
  let result: ForcedCallResult;
  try {
    result = await forcedFunctionCall(req);
  } catch (err) {
    if (err instanceof ModelContractError) return { ok: false, error: err.message, rawArgs: err.detail };
    throw err;
  }
  const schema = req.schemas[result.name];
  if (!schema) return { ok: false, error: `No schema for ${result.name}`, name: result.name, rawArgs: result.args };
  const parsed = schema.safeParse(result.args);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Function call arguments failed schema validation',
      name: result.name,
      rawArgs: result.args,
      issues: parsed.error.issues,
      modelVersion: result.modelVersion,
    };
  }
  return {
    ok: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { name: result.name, value: parsed.data } as any,
    name: result.name,
    rawArgs: result.args,
    modelVersion: result.modelVersion,
  };
}
