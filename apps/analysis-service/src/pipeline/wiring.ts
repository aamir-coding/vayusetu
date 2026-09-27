import type { FastifyBaseLogger } from 'fastify';
import { publishEvent } from '@vayusetu/gcp-clients';
import { createGeminiClient, resolveLocation, resolveModels } from '@vayusetu/gemini-client';
import { env } from '../config/env.js';
import { createContextLoader } from '../adapters/context.js';
import { createGeminiTriage } from '../adapters/gemini.js';
import { createArchiver, createSynthesizer, createTranscriber } from '../adapters/speech.js';
import type { AnalysisDeps } from './analyze.js';

export function buildAnalysisDeps(logger: FastifyBaseLogger): AnalysisDeps {
  const models = resolveModels();
  const ai = createGeminiClient({ project: env.GOOGLE_CLOUD_PROJECT, location: resolveLocation() });
  const synthesize = env.ADVISORY_AUDIO_BUCKET
    ? createSynthesizer({ bucket: env.ADVISORY_AUDIO_BUCKET, voiceSuffix: env.TTS_VOICE_SUFFIX })
    : async () => undefined;
  const archive = env.RAW_ARCHIVE_BUCKET ? createArchiver({ bucket: env.RAW_ARCHIVE_BUCKET }) : async () => undefined;
  if (!env.ADVISORY_AUDIO_BUCKET) logger.warn('ADVISORY_AUDIO_BUCKET unset: advisories are text-only (Pipeline B off)');
  if (!env.RAW_ARCHIVE_BUCKET) logger.warn('RAW_ARCHIVE_BUCKET unset: raw model responses are not archived');

  logger.info({ triageModel: models.triage, stt: `${env.STT_MODEL}@${env.STT_LOCATION}` }, 'analysis pipeline ready');
  return {
    triage: createGeminiTriage(ai, models.triage),
    transcribe: createTranscriber({ project: env.GOOGLE_CLOUD_PROJECT, location: env.STT_LOCATION, model: env.STT_MODEL }),
    loadContext: createContextLoader({
      project: env.GOOGLE_CLOUD_PROJECT,
      dataset: env.BQ_DATASET,
      mapsApiKey: env.GOOGLE_MAPS_API_KEY,
      monitorFreshHours: env.MONITOR_FRESH_HOURS,
      monitorMaxDistanceKm: env.MONITOR_MAX_DISTANCE_KM,
      logger,
    }),
    synthesize,
    archiveRaw: archive,
    publishCompleted: async (payload) => {
      await publishEvent('analysis.completed', payload);
    },
    now: () => new Date(),
    logger,
    clarifyBelowConfidence: env.CLARIFY_BELOW_CONFIDENCE,
  };
}
