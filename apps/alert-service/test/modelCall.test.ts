import { describe, expect, it, vi } from 'vitest';
import type { GenerateContentParameters, GenerateContentResponse } from '@vayusetu/gemini-client';
import { createPipelineCModelCall } from '../src/gemini/modelCall.js';
import { DRAFT_ALERT_BRIEFING_FUNCTION, PIPELINE_C_SYSTEM_INSTRUCTION } from '../src/gemini/briefingPrompt.js';

function fake(response: Partial<GenerateContentResponse>) {
  const calls: GenerateContentParameters[] = [];
  const ai = {
    models: {
      generateContent: vi.fn(async (p: GenerateContentParameters) => {
        calls.push(p);
        return response as GenerateContentResponse;
      }),
    },
  };
  return { ai, calls };
}

describe('createPipelineCModelCall (Engineer 3 seam)', () => {
  const args = { title: 'Severe smog building over Anand Vihar', description: 'd', impliedGrapStage: 'stage_3', recommendedActions: ['a', 'b'], publicAdvisory: 'p', citedSignals: ['x'] };

  it('forces draft_alert_briefing on the briefing model and returns raw args', async () => {
    const { ai, calls } = fake({ functionCalls: [{ name: 'draft_alert_briefing', args }] });
    const call = createPipelineCModelCall({ project: 'p', ai, env: { GEMINI_BRIEFING_MODEL: 'gemini-3.1-pro-preview' } });
    const signal = new AbortController().signal;
    const out = await call({ systemInstruction: PIPELINE_C_SYSTEM_INSTRUCTION, functionDeclaration: DRAFT_ALERT_BRIEFING_FUNCTION, payload: { event: { kind: 'hotspot' } }, signal });

    expect(out).toEqual(args);
    const req = calls[0]!;
    expect(req.model).toBe('gemini-3.1-pro-preview');
    expect(req.config?.systemInstruction).toBe(PIPELINE_C_SYSTEM_INSTRUCTION);
    expect(req.config?.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual(['draft_alert_briefing']);
    expect(req.config?.abortSignal).toBe(signal);
    expect(req.contents).toEqual([{ role: 'user', parts: [{ text: JSON.stringify({ event: { kind: 'hotspot' } }) }] }]);
  });

  it('throws when the model answers without the function call (generator falls back to template)', async () => {
    const { ai } = fake({ functionCalls: undefined });
    const call = createPipelineCModelCall({ project: 'p', ai, env: {} });
    await expect(
      call({ systemInstruction: 's', functionDeclaration: DRAFT_ALERT_BRIEFING_FUNCTION, payload: {}, signal: new AbortController().signal }),
    ).rejects.toThrow();
  });
});
