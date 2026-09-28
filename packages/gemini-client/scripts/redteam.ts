// Pipeline A red-team run against the live model on Vertex AI (needs ADC).
//   GOOGLE_CLOUD_PROJECT=vayusetu-ncr-dev pnpm --filter @vayusetu/gemini-client redteam [--only <id,...>] [--repeat N]
// Cost: one Gemini Flash call per case per repeat (27 cases ~ a few US cents).
// Writes redteam/results/<timestamp>.json and exits 1 if any case fails.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Part } from '@google/genai';
import {
  PIPELINE_A_SYSTEM_INSTRUCTION,
  RECORD_AIR_QUALITY_ASSESSMENT,
  RecordAirQualityAssessmentSchema,
  buildPipelineAParts,
  callWithSchema,
  createGeminiClient,
  resolveLocation,
  resolveModels,
  type PipelineAContext,
} from '../src/index.js';
import { violations, type RedTeamCase } from '../redteam/evaluate.js';

const dir = (rel: string) => fileURLToPath(new URL(`../redteam/${rel}`, import.meta.url));
const { defaults, cases } = JSON.parse(readFileSync(dir('cases.json'), 'utf-8')) as {
  defaults: { advisoryLanguage: string; context: PipelineAContext };
  cases: RedTeamCase[];
};

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1]!.split(',')) : null;
const repeat = args.includes('--repeat') ? Number(args[args.indexOf('--repeat') + 1]) : 1;
if (!process.env.GOOGLE_CLOUD_PROJECT) {
  console.error('GOOGLE_CLOUD_PROJECT is required');
  process.exit(1);
}

const ai = createGeminiClient({ project: process.env.GOOGLE_CLOUD_PROJECT, location: resolveLocation() });
const model = resolveModels().triage;

/** The production parts, with the photo sent inline instead of as a gs:// fileData reference. */
function parts(c: RedTeamCase): Part[] {
  const built = buildPipelineAParts({
    photo: { gcsUri: 'gs://redteam/placeholder.jpg', mimeType: 'image/jpeg' },
    ...(c.transcript ? { transcript: c.transcript } : {}),
    advisoryLanguage: c.advisoryLanguage ?? defaults.advisoryLanguage,
    context: { ...defaults.context, ...(c.context as Partial<PipelineAContext>) },
  });
  const image = readFileSync(dir(`images/${c.image}`)).toString('base64');
  return [{ inlineData: { mimeType: 'image/jpeg', data: image } }, ...built.slice(1)];
}

interface Outcome {
  id: string;
  category: string;
  run: number;
  pass: boolean;
  reasons: string[];
  result?: unknown;
  ms: number;
}

const selected = cases.filter((c) => !only || only.has(c.id));
const outcomes: Outcome[] = [];
for (let run = 1; run <= repeat; run++) {
  // Small concurrency: the triage model's quota is per minute.
  for (let i = 0; i < selected.length; i += 3) {
    await Promise.all(
      selected.slice(i, i + 3).map(async (c) => {
        const t0 = Date.now();
        const res = await callWithSchema({
          ai,
          model,
          systemInstruction: PIPELINE_A_SYSTEM_INSTRUCTION,
          functions: [RECORD_AIR_QUALITY_ASSESSMENT],
          parts: parts(c),
          schemas: { record_air_quality_assessment: RecordAirQualityAssessmentSchema },
        });
        const reasons = res.ok ? violations(res.data.value, c.expect) : [`contract failure: ${res.error}`];
        outcomes.push({ id: c.id, category: c.category, run, pass: reasons.length === 0, reasons, result: res.ok ? res.data.value : res.rawArgs, ms: Date.now() - t0 });
        const r = res.ok ? res.data.value : undefined;
        console.log(
          `${reasons.length ? 'FAIL' : 'pass'}  ${c.id.padEnd(38)} ${r ? `${r.sourceClassification} sev=${r.severityEstimate} conf=${r.confidenceScore} review=${r.needsHumanReview}` : ''}${reasons.length ? `\n      -> ${reasons.join('; ')}` : ''}`,
        );
      }),
    );
  }
}

const byCategory = new Map<string, { pass: number; total: number }>();
for (const o of outcomes) {
  const s = byCategory.get(o.category) ?? { pass: 0, total: 0 };
  s.total++;
  if (o.pass) s.pass++;
  byCategory.set(o.category, s);
}
const passed = outcomes.filter((o) => o.pass).length;
console.log(`\n${passed}/${outcomes.length} passed (${model})`);
for (const [cat, s] of byCategory) console.log(`  ${cat.padEnd(10)} ${s.pass}/${s.total}`);

mkdirSync(dir('results'), { recursive: true });
const file = dir(`results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ model, promptVersion: 'AI_PIPELINES.md', ranAt: new Date().toISOString(), repeat, passed, total: outcomes.length, outcomes }, null, 2) + '\n');
console.log(`results: ${file}`);
process.exitCode = passed === outcomes.length ? 0 : 1;
