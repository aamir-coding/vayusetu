import { describe, expect, it } from 'vitest';
import type { GenerativeModelTransport } from '@vayusetu/gemini-client';
import { createGeminiTriage } from '../src/adapters/gemini.js';

describe('Gemini triage timeout (audit H3)', () => {
  it('aborts a hung model call instead of outliving the Pub/Sub ack deadline', async () => {
    let sawSignal = false;
    const hanging: GenerativeModelTransport = {
      models: {
        generateContent: (params) =>
          new Promise((_, reject) => {
            const signal = (params.config as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            sawSignal = Boolean(signal);
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      },
    };
    const triage = createGeminiTriage(hanging, 'gemini-test', 50);
    const started = Date.now();
    const input = {
      photo: { gcsUri: 'gs://b/submissions/u/p.jpg', mimeType: 'image/jpeg' },
      advisoryLanguage: 'en-IN',
      context: { localTime: '2026-11-03 07:40 IST', season: 'post-monsoon', nearestMonitor: { id: 'm', aqi: 120, aqiCategory: 'moderate', distanceKm: 2 } },
    };
    await expect(triage(input as never, 'assess')).rejects.toBeDefined();
    expect(sawSignal).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
