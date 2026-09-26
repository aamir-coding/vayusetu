import { getDb, NonRetryableEventError } from '@vayusetu/gcp-clients';
import {
  MAX_CLARIFICATION_TURNS,
  type AskClarifyingQuestion,
  type PipelineAContext,
  type PipelineAInput,
  type RecordAirQualityAssessment,
} from '@vayusetu/gemini-client';
import type { AnalysisResult, ClarificationExchange, Submission, User } from '@vayusetu/shared-types';
import { crossValidate, istLabel, seasonFor, type Reference } from './crossValidate.js';

export type TriageMode = 'assess' | 'clarify';

export type TriageOutcome =
  | { kind: 'assessment'; value: RecordAirQualityAssessment; modelVersion: string; raw: unknown }
  | { kind: 'question'; value: AskClarifyingQuestion; modelVersion: string; raw: unknown }
  | { kind: 'invalid'; error: string; raw: unknown };

export interface LoadedContext {
  context: PipelineAContext;
  corridorId?: string;
  reference?: Reference;
  crossValidation: { nearestMonitorId?: string; nearestMonitorAQI?: number; satelliteAODAtCell?: number };
}

export interface AnalysisDeps {
  triage(input: PipelineAInput, mode: TriageMode): Promise<TriageOutcome>;
  transcribe(audioGsUrl: string, language: string): Promise<string | undefined>;
  loadContext(submission: Submission): Promise<LoadedContext>;
  synthesize(text: string, language: string): Promise<string | undefined>;
  archiveRaw(submissionId: string, raw: unknown): Promise<string | undefined>;
  publishCompleted(payload: { submissionId: string; h3Index: string; corridorId: string }): Promise<void>;
  now(): Date;
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  clarifyBelowConfidence: number;
}

export type AnalysisOutcome =
  | 'analyzed'
  | 'flagged_for_review'
  | 'awaiting_clarification'
  | 'failed_model_output'
  | 'skipped_duplicate';

const DEFAULT_LANGUAGE = 'en-IN';
const UNCLASSIFIED_NOTE = 'Recorded as unclassified; will be reviewed.';

function mimeFromUrl(url: string): string {
  const ext = url.split('?')[0]!.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
}

const submissions = () => getDb().collection('submissions');
const analysisResults = () => getDb().collection('analysisResults');
const users = () => getDb().collection('users');

/**
 * A redelivered submission.created must not re-bill Gemini or clobber a
 * finished result. Only two statuses mean "work to do": `queued` (first
 * delivery) and `pending_analysis` (retry-analysis, a clarification answer,
 * or a redelivery after a transient failure mid-run).
 */
function isDuplicate(sub: Submission): boolean {
  return sub.status !== 'queued' && sub.status !== 'pending_analysis';
}

function degradedContext(sub: Submission, now: Date): LoadedContext {
  const captured = new Date(sub.capturedAt);
  const at = Number.isNaN(captured.getTime()) ? now : captured;
  return { context: { localTime: istLabel(at), season: seasonFor(at) }, crossValidation: {} };
}

export async function analyzeSubmission(submissionId: string, deps: AnalysisDeps): Promise<AnalysisOutcome> {
  const subRef = submissions().doc(submissionId);
  const snap = await subRef.get();
  if (!snap.exists) throw new NonRetryableEventError(`submissions/${submissionId} does not exist`);
  const sub = snap.data() as Submission;
  const existingSnap = await analysisResults().doc(submissionId).get();
  const existing = existingSnap.exists ? (existingSnap.data() as AnalysisResult) : undefined;
  if (isDuplicate(sub)) return 'skipped_duplicate';

  await subRef.set({ status: 'pending_analysis' }, { merge: true });
  const log = { submissionId };

  const userSnap = await users().doc(sub.userId).get();
  const language = (userSnap.exists ? (userSnap.data() as User).preferredLanguage : undefined) || DEFAULT_LANGUAGE;

  // ---- voice note (non-fatal: triage proceeds on the photo alone) ----
  let transcript = sub.transcript;
  if (sub.audioStorageUrl && !transcript) {
    try {
      transcript = await deps.transcribe(sub.audioStorageUrl, language);
      if (transcript) await subRef.set({ transcript }, { merge: true });
    } catch (err) {
      deps.logger.warn({ ...log, err }, 'Speech-to-Text failed; continuing without transcript');
    }
  }

  // ---- context (non-fatal: degrade to time/season only) ----
  let ctx: LoadedContext;
  try {
    ctx = await deps.loadContext(sub);
  } catch (err) {
    deps.logger.warn({ ...log, err }, 'Context lookup failed; triaging without reference data');
    ctx = degradedContext(sub, deps.now());
  }

  const clarifications: ClarificationExchange[] = [...(sub.clarifications ?? [])];
  const answered = clarifications.filter((c) => c.answeredAt);
  const input: PipelineAInput = {
    photo: { gcsUri: sub.photoStorageUrl, mimeType: mimeFromUrl(sub.photoStorageUrl) },
    ...(transcript ? { transcript } : {}),
    context: ctx.context,
    advisoryLanguage: language,
    clarifications: answered.map((c) => ({
      question: c.question,
      ...(c.answerText ? { answerText: c.answerText } : {}),
      ...(c.answerPhotoStorageUrl
        ? { answerPhoto: { gcsUri: c.answerPhotoStorageUrl, mimeType: mimeFromUrl(c.answerPhotoStorageUrl) } }
        : {}),
    })),
  };

  // ---- Gemini: Pipeline A, or Pipeline D once the citizen has answered ----
  let outcome = await deps.triage(input, answered.length > 0 ? 'clarify' : 'assess');
  if (outcome.kind === 'invalid') outcome = await deps.triage(input, answered.length > 0 ? 'clarify' : 'assess');
  const rawResponses: unknown[] = [outcome.raw];
  if (outcome.kind === 'invalid') {
    deps.logger.warn({ ...log, error: outcome.error }, 'Model output failed validation twice; marking failed');
    await subRef.set({ status: 'failed' }, { merge: true });
    await deps.archiveRaw(submissionId, rawResponses).catch(() => undefined);
    return 'failed_model_output';
  }

  let assessment: RecordAirQualityAssessment | undefined = outcome.kind === 'assessment' ? outcome.value : undefined;
  let modelVersion = outcome.modelVersion;

  // Pipeline D entry: indeterminate + low confidence, turns left.
  if (
    outcome.kind === 'assessment' &&
    outcome.value.sourceClassification === 'indeterminate' &&
    outcome.value.confidenceScore < deps.clarifyBelowConfidence &&
    clarifications.length < MAX_CLARIFICATION_TURNS
  ) {
    const d = await deps.triage(input, 'clarify');
    rawResponses.push(d.raw);
    if (d.kind !== 'invalid') {
      outcome = d;
      modelVersion = d.modelVersion;
      if (d.kind === 'assessment') assessment = d.value;
    }
  }

  // ---- a question for the citizen ----
  if (outcome.kind === 'question' && clarifications.length < MAX_CLARIFICATION_TURNS) {
    const turn = (clarifications.length + 1) as 1 | 2;
    clarifications.push({ turn, question: outcome.value.question, language, askedAt: deps.now().toISOString() });
    const base = assessment ?? existing;
    const rawResponseStorageUrl = await deps.archiveRaw(submissionId, rawResponses).catch(() => undefined);
    const result: AnalysisResult = {
      submissionId,
      sourceClassification: 'indeterminate',
      severityEstimate: (base?.severityEstimate ?? 1) as AnalysisResult['severityEstimate'],
      skyOpacityScore: base?.skyOpacityScore ?? 0,
      plumeDetected: base?.plumeDetected ?? false,
      confidenceScore: Math.min(base?.confidenceScore ?? 0, 0.3),
      needsHumanReview: true,
      reviewNote: 'Awaiting citizen clarification.',
      crossValidation: ctx.crossValidation,
      advisory: {
        text: assessment?.recommendedAdvisory ?? existing?.advisory.text ?? '',
        language,
        ...(existing?.advisory.audioStorageUrl ? { audioStorageUrl: existing.advisory.audioStorageUrl } : {}),
      },
      pendingClarification: { turn, question: outcome.value.question, language },
      modelVersion,
      ...(rawResponseStorageUrl ? { rawResponseStorageUrl } : {}),
      createdAt: deps.now().toISOString(),
    };
    await analysisResults().doc(submissionId).set(result);
    await subRef.set({ status: 'flagged_for_review', clarifications }, { merge: true });
    deps.logger.info({ ...log, turn }, 'Pipeline D: clarification requested');
    return 'awaiting_clarification';
  }

  // ---- final assessment (or the unclassified fallback) ----
  const final: RecordAirQualityAssessment = assessment ?? {
    sourceClassification: 'indeterminate',
    severityEstimate: 1,
    skyOpacityScore: existing?.skyOpacityScore ?? 0,
    plumeDetected: false,
    confidenceScore: 0,
    needsHumanReview: true,
    reviewNote: UNCLASSIFIED_NOTE,
    recommendedAdvisory: existing?.advisory.text ?? '',
    advisoryLanguage: language,
  };
  const xv = crossValidate(final, ctx.reference);
  const exhaustedIndeterminate =
    final.sourceClassification === 'indeterminate' && clarifications.length >= MAX_CLARIFICATION_TURNS;
  const needsHumanReview = final.needsHumanReview || xv.disagrees || exhaustedIndeterminate;
  const reviewNote =
    [final.reviewNote, xv.note, exhaustedIndeterminate && final.reviewNote !== UNCLASSIFIED_NOTE ? UNCLASSIFIED_NOTE : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  let audioStorageUrl: string | undefined;
  if (final.recommendedAdvisory) {
    try {
      audioStorageUrl = await deps.synthesize(final.recommendedAdvisory, language);
    } catch (err) {
      deps.logger.warn({ ...log, err }, 'Text-to-Speech failed; advisory is text-only');
    }
  }
  const rawResponseStorageUrl = await deps.archiveRaw(submissionId, rawResponses).catch(() => undefined);

  const result: AnalysisResult = {
    submissionId,
    sourceClassification: final.sourceClassification,
    severityEstimate: final.severityEstimate as AnalysisResult['severityEstimate'],
    skyOpacityScore: final.skyOpacityScore,
    plumeDetected: final.plumeDetected,
    ...(final.visibilityMeters !== undefined ? { visibilityMeters: final.visibilityMeters } : {}),
    confidenceScore: final.confidenceScore,
    needsHumanReview,
    ...(reviewNote ? { reviewNote } : {}),
    ...(xv.estimatedAQICategory ? { estimatedAQICategory: xv.estimatedAQICategory } : {}),
    crossValidation: { ...ctx.crossValidation, ...(xv.agreementScore !== undefined ? { agreementScore: xv.agreementScore } : {}) },
    // The requested language, not whatever tag the model echoed back.
    advisory: { text: final.recommendedAdvisory, language, ...(audioStorageUrl ? { audioStorageUrl } : {}) },
    modelVersion,
    ...(rawResponseStorageUrl ? { rawResponseStorageUrl } : {}),
    createdAt: deps.now().toISOString(),
  };
  await analysisResults().doc(submissionId).set(result);
  const status = needsHumanReview ? 'flagged_for_review' : 'analyzed';
  await subRef.set({ status, clarifications }, { merge: true });

  if (ctx.corridorId) {
    await deps.publishCompleted({ submissionId, h3Index: sub.h3Index, corridorId: ctx.corridorId });
  } else {
    deps.logger.warn({ ...log, h3Index: sub.h3Index }, 'Report is outside every configured corridor; analysis.completed not published');
  }
  deps.logger.info(
    { ...log, classification: result.sourceClassification, confidence: result.confidenceScore, agreement: xv.agreementScore, status },
    'analysis complete',
  );
  return status;
}
