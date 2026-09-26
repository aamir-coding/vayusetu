// Live round trip: Pipeline A (+D) against Vertex AI. Needs ADC.
//   GOOGLE_CLOUD_PROJECT=vayusetu-ncr-dev pnpm --filter @vayusetu/gemini-client smoke gs://bucket/photo.jpg [hi-IN]
import {
  ASK_CLARIFYING_QUESTION,
  AskClarifyingQuestionSchema,
  PIPELINE_A_SYSTEM_INSTRUCTION,
  PIPELINE_D_SYSTEM_INSTRUCTION,
  RECORD_AIR_QUALITY_ASSESSMENT,
  RecordAirQualityAssessmentSchema,
  buildPipelineAParts,
  callWithSchema,
  createGeminiClient,
  resolveLocation,
  resolveModels,
} from '../src/index.js';

const [gcsUri, lang = 'hi-IN'] = process.argv.slice(2);
if (!gcsUri?.startsWith('gs://') || !process.env.GOOGLE_CLOUD_PROJECT) {
  console.error('usage: GOOGLE_CLOUD_PROJECT=... smoke.ts gs://bucket/photo.jpg [lang]');
  process.exit(1);
}
const ai = createGeminiClient({ project: process.env.GOOGLE_CLOUD_PROJECT, location: resolveLocation() });
const models = resolveModels();
const parts = buildPipelineAParts({
  photo: { gcsUri, mimeType: 'image/jpeg' },
  advisoryLanguage: lang,
  context: { localTime: '2026-11-03 07:40 IST', season: 'post-monsoon', nearestMonitor: { id: 'anand-vihar-delhi-dpcc', aqi: 380, aqiCategory: 'very_poor', distanceKm: 2.1 } },
});
for (const [label, systemInstruction, functions] of [
  ['Pipeline A', PIPELINE_A_SYSTEM_INSTRUCTION, [RECORD_AIR_QUALITY_ASSESSMENT]],
  ['Pipeline D', PIPELINE_D_SYSTEM_INSTRUCTION, [RECORD_AIR_QUALITY_ASSESSMENT, ASK_CLARIFYING_QUESTION]],
] as const) {
  const t0 = Date.now();
  const res = await callWithSchema({
    ai, model: models.triage, systemInstruction, functions: [...functions], parts,
    schemas: { record_air_quality_assessment: RecordAirQualityAssessmentSchema, ask_clarifying_question: AskClarifyingQuestionSchema },
  });
  console.log(`\n${label} (${models.triage}, ${Date.now() - t0} ms):`, JSON.stringify(res, null, 2));
}
