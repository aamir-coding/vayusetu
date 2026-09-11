/**
 * Pipeline A prompt-tuning harness.
 *
 * TEAM_ROLES_AND_REPO_MAP.md, Engineer 3, Week 1:
 *   "Pipeline A's system instruction hand-tuned against ~50 labeled real
 *    photos before wiring into any service."
 *
 * Workflow:
 *   1. Collect ~50 real (or realistic) citizen photos covering every
 *      sourceClassification value, including a good number of
 *      no_visible_pollution and indeterminate cases -- those are the
 *      ones a red-team pass (Week 4) will punish you for getting wrong.
 *   2. Upload them to a dev GCS bucket, fill in data/labels.json (see
 *      data/README.md + data/labels.schema.json for the shape).
 *   3. `pnpm start` from this directory.
 *   4. Read the confusion list. Edit the prompt in
 *      packages/gemini-client/src/prompts/pipelineA.ts. Re-run. Repeat.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGeminiClient,
  MODEL_IDS,
  callWithFunctionSchema,
  recordAirQualityAssessmentSchema,
  type RecordAirQualityAssessment,
  PIPELINE_A_SYSTEM_INSTRUCTION,
  PIPELINE_A_FUNCTION_NAME,
  PIPELINE_A_FUNCTION_DESCRIPTION,
} from "@vayusetu/gemini-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface LabeledExample {
  id: string;
  gcsUri: string;
  contextText: string;
  expected: {
    sourceClassification: RecordAirQualityAssessment["sourceClassification"];
    /** Optional -- graded with tolerance (|delta|), not exact match. */
    severityEstimate?: number;
    needsHumanReview?: boolean;
  };
  notes?: string;
}

interface EvalRow {
  id: string;
  expectedClass: string;
  predictedClass: string;
  classMatch: boolean;
  expectedSeverity?: number;
  predictedSeverity?: number;
  severityDelta?: number;
  confidenceScore?: number;
  needsHumanReview?: boolean;
  error?: string;
}

async function main() {
  const project = process.env.GCP_PROJECT_ID;
  if (!project) throw new Error("Set GCP_PROJECT_ID (see .env.example at repo root).");
  const location = process.env.GCP_LOCATION ?? "asia-south1";
  const ai = createGeminiClient({ project, location });

  const labelsPath = path.resolve(__dirname, "data/labels.json");
  let examples: LabeledExample[];
  try {
    examples = JSON.parse(readFileSync(labelsPath, "utf-8"));
  } catch {
    console.error(
      `Couldn't read ${labelsPath}.\n` +
        `Copy data/labels.example.json to data/labels.json and fill in your ` +
        `~50 labeled photos first (see data/README.md).`
    );
    process.exit(1);
  }

  console.log(`Running Pipeline A against ${examples.length} labeled examples...\n`);

  const rows: EvalRow[] = [];
  for (const ex of examples) {
    const result = await callWithFunctionSchema({
      ai,
      model: MODEL_IDS.triageFlash,
      systemInstruction: PIPELINE_A_SYSTEM_INSTRUCTION,
      functionName: PIPELINE_A_FUNCTION_NAME,
      functionDescription: PIPELINE_A_FUNCTION_DESCRIPTION,
      schema: recordAirQualityAssessmentSchema,
      parts: [
        { fileData: { fileUri: ex.gcsUri, mimeType: "image/jpeg" } },
        { text: ex.contextText },
      ],
    });

    if (!result.ok) {
      rows.push({
        id: ex.id,
        expectedClass: ex.expected.sourceClassification,
        predictedClass: "ERROR",
        classMatch: false,
        error: result.error,
      });
      continue;
    }

    const d = result.data;
    rows.push({
      id: ex.id,
      expectedClass: ex.expected.sourceClassification,
      predictedClass: d.sourceClassification,
      classMatch: d.sourceClassification === ex.expected.sourceClassification,
      expectedSeverity: ex.expected.severityEstimate,
      predictedSeverity: d.severityEstimate,
      severityDelta:
        ex.expected.severityEstimate !== undefined
          ? Math.abs(d.severityEstimate - ex.expected.severityEstimate)
          : undefined,
      confidenceScore: d.confidenceScore,
      needsHumanReview: d.needsHumanReview,
    });
  }

  printReport(rows);
}

function printReport(rows: EvalRow[]) {
  const total = rows.length;
  const errored = rows.filter((r) => r.error);
  const graded = rows.filter((r) => !r.error);
  const classAccuracy = graded.length ? graded.filter((r) => r.classMatch).length / graded.length : 0;
  const severityDeltas = graded
    .map((r) => r.severityDelta)
    .filter((v): v is number => v !== undefined);
  const meanSeverityDelta = severityDeltas.length
    ? severityDeltas.reduce((a, b) => a + b, 0) / severityDeltas.length
    : null;

  console.log(`=== Pipeline A eval: ${total} examples, ${errored.length} errored ===`);
  console.log(`Classification exact-match accuracy: ${(classAccuracy * 100).toFixed(1)}%`);
  if (meanSeverityDelta !== null) {
    console.log(`Mean |severity error| (where expected was given): ${meanSeverityDelta.toFixed(2)}`);
  }

  const mismatches = graded.filter((r) => !r.classMatch);
  console.log(`\nMisclassifications (${mismatches.length}):`);
  for (const r of mismatches) {
    console.log(`  ${r.id}: expected ${r.expectedClass} -> got ${r.predictedClass}`);
  }

  if (errored.length) {
    console.log(`\nErrored calls (${errored.length}):`);
    for (const r of errored) console.log(`  ${r.id}: ${r.error}`);
  }

  console.log(
    "\nPay special attention to: any no_visible_pollution/indeterminate example\n" +
      "misclassified as a pollution source (false alarm), and any real pollution\n" +
      "photo classified as no_visible_pollution (missed detection) -- these are\n" +
      "exactly what the Week 4 adversarial/red-team pass will probe."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
