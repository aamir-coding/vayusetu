import type { AnalysisResult, Jurisdiction, Submission, User } from '@vayusetu/shared-types';

/**
 * A tiny in-memory "backend" the MSW handlers read/write. This is what
 * lets the mock loop feel real: submit a report, watch it appear in My
 * Reports as `queued` → `pending_analysis` → `analyzed`, poll
 * GET /analysis/:id and actually see the transition. Resets on page
 * reload — that's fine, it's a Week 1 dev aid, not a persistence layer.
 */

export const db = {
  users: new Map<string, User>(),
  submissions: new Map<string, Submission>(),
  analysisResults: new Map<string, AnalysisResult>(),
};

const NCR_DELHI: Jurisdiction = { stateCode: 'DL', districtCode: 'DL-CENTRAL' };

let submissionSeq = 0;

/** Decode the uid from either a real Firebase ID token (unverified, mock-purposes-only) or our own `mock-token:<uid>` shape. */
export function extractUid(authHeader: string | null): string {
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '');
  if (token.startsWith('mock-token:')) return token.slice('mock-token:'.length);
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? ''));
    return payload.user_id ?? payload.sub ?? 'unknown-user';
  } catch {
    return 'unknown-user';
  }
}

export function getOrThrowUser(uid: string): User {
  const user = db.users.get(uid);
  if (!user) throw new Error('NOT_FOUND');
  return user;
}

/** Generates a plausible-but-fake AnalysisResult so SnapshotResult has something real to render. Deterministic-ish rotation, not random noise, so a demo is repeatable. */
export function fabricateAnalysis(submission: Submission): AnalysisResult {
  submissionSeq += 1;
  const rotation = submissionSeq % 4;
  const presets: Array<Pick<AnalysisResult, 'sourceClassification' | 'severityEstimate' | 'skyOpacityScore' | 'estimatedAQICategory' | 'confidenceScore' | 'needsHumanReview'> & { advisoryEn: string }> = [
    {
      sourceClassification: 'open_waste_burning',
      severityEstimate: 4,
      skyOpacityScore: 0.72,
      estimatedAQICategory: 'very_poor',
      confidenceScore: 0.86,
      needsHumanReview: false,
      advisoryEn: 'Avoid outdoor exercise near this location for the next few hours.',
    },
    {
      sourceClassification: 'vehicular_smog',
      severityEstimate: 3,
      skyOpacityScore: 0.51,
      estimatedAQICategory: 'poor',
      confidenceScore: 0.74,
      needsHumanReview: false,
      advisoryEn: 'Consider a mask if you are sensitive to smog during peak traffic hours.',
    },
    {
      sourceClassification: 'no_visible_pollution',
      severityEstimate: 1,
      skyOpacityScore: 0.08,
      estimatedAQICategory: 'good',
      confidenceScore: 0.91,
      needsHumanReview: false,
      advisoryEn: 'Air looks clear here right now — thanks for keeping an eye on it.',
    },
    {
      sourceClassification: 'indeterminate',
      severityEstimate: 2,
      skyOpacityScore: 0.35,
      estimatedAQICategory: undefined,
      confidenceScore: 0.22,
      needsHumanReview: true,
      advisoryEn: "We couldn't confidently classify this one — it's been flagged for a quick human check.",
    },
  ];
  const preset = presets[rotation]!;
  return {
    submissionId: submission.id,
    sourceClassification: preset.sourceClassification,
    severityEstimate: preset.severityEstimate as 1 | 2 | 3 | 4 | 5,
    skyOpacityScore: preset.skyOpacityScore,
    plumeDetected: preset.severityEstimate >= 3,
    visibilityMeters: Math.round(2200 * (1 - preset.skyOpacityScore)),
    confidenceScore: preset.confidenceScore,
    needsHumanReview: preset.needsHumanReview,
    reviewNote: preset.needsHumanReview ? 'Visual assessment inconclusive; disagreement with satellite context exceeds threshold.' : undefined,
    estimatedAQICategory: preset.estimatedAQICategory,
    crossValidation: {
      nearestMonitorId: 'DL-DPCC-014',
      nearestMonitorAQI: 214,
      satelliteAODAtCell: 0.63,
      agreementScore: 0.8,
    },
    advisory: {
      text: preset.advisoryEn,
      language: submission.jurisdiction ? 'en-IN' : 'en-IN',
    },
    modelVersion: 'gemini-3.7-flash@mock',
    createdAt: new Date().toISOString(),
  };
}

export function nextSubmissionId(): string {
  submissionSeq += 1;
  return `sub-${Date.now()}-${submissionSeq}`;
}

export const DEFAULT_JURISDICTION = NCR_DELHI;
