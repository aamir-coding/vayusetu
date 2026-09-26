// Live check of every real adapter (no Firestore writes). Needs ADC + GOOGLE_MAPS_API_KEY.
//   GOOGLE_CLOUD_PROJECT=vayusetu-ncr-dev PUBSUB_PUSH_AUTH=off npx tsx scripts/live-adapters.ts
import { getBigQuery } from '@vayusetu/gcp-clients';
import { createGeminiClient, resolveLocation, resolveModels } from '@vayusetu/gemini-client';
import type { Submission } from '@vayusetu/shared-types';
import { createContextLoader } from '../src/adapters/context.js';
import { createGeminiTriage } from '../src/adapters/gemini.js';
import { createArchiver, createSynthesizer, createTranscriber } from '../src/adapters/speech.js';

const project = process.env.GOOGLE_CLOUD_PROJECT!;
const log = { warn: (o: object, m: string) => console.log('WARN', m, o) };
const time = async <T>(label: string, fn: () => Promise<T>) => {
  const t0 = Date.now();
  const out = await fn();
  console.log(`\n== ${label} (${Date.now() - t0} ms)\n`, JSON.stringify(out, null, 2)?.slice(0, 1500));
  return out;
};

const [[cell]] = await getBigQuery().query(
  `SELECT h3_index, lat, lng FROM \`${project}.core.h3_cells\` WHERE nearest_station_distance_km < 1.5 ORDER BY nearest_station_distance_km LIMIT 1`,
);
const sub = {
  id: 'live-check', userId: 'x', mediaType: 'photo', h3Index: cell.h3_index, geo: { lat: cell.lat, lng: cell.lng },
  photoStorageUrl: 'gs://vayusetu-ncr-dev-reference/smoke/vehicular_smog_delhi_2019.jpg',
  capturedAt: new Date().toISOString(),
} as unknown as Submission;

const ctx = await time('context (BigQuery + Air Quality API)', () =>
  createContextLoader({ project, dataset: 'core', mapsApiKey: process.env.GOOGLE_MAPS_API_KEY, monitorFreshHours: 6, monitorMaxDistanceKm: 5, logger: log })(sub),
);
await time('Speech-to-Text chirp_3 (pa-IN voice note)', () =>
  createTranscriber({ project, location: 'us', model: 'chirp_3' })('gs://vayusetu-ncr-dev-reference/smoke/voice-pa.ogg', 'pa-IN'),
);
const triage = createGeminiTriage(createGeminiClient({ project, location: resolveLocation() }), resolveModels().triage);
const out = await time('Gemini Pipeline A with real context', () =>
  triage({ photo: { gcsUri: sub.photoStorageUrl, mimeType: 'image/jpeg' }, context: ctx.context, advisoryLanguage: 'pa-IN' }, 'assess'),
);
const text = out.kind === 'assessment' ? out.value.recommendedAdvisory : 'ਬਾਹਰ ਕਸਰਤ ਤੋਂ ਬਚੋ।';
const synth = createSynthesizer({ bucket: `${project}-advisory-audio`, voiceSuffix: 'Chirp3-HD-Aoede' });
await time('TTS first call (synthesize + store)', () => synth(text, 'pa-IN'));
await time('TTS second call (cache hit)', () => synth(text, 'pa-IN'));
await time('raw archive', () => createArchiver({ bucket: `${project}-model-artifacts` })('live-check', out.kind === 'invalid' ? out : out.raw));
