import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AnalysisResult, Submission } from '@vayusetu/shared-types';
import { FakeFirestore } from '@vayusetu/gcp-clients/testing';

const fakeDb = new FakeFirestore();
vi.mock('@vayusetu/gcp-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vayusetu/gcp-clients')>()),
  getDb: () => fakeDb,
}));

const PUSH_SA = 'pubsub-push-test@vayusetu-test.iam.gserviceaccount.com';
Object.assign(process.env, {
  NODE_ENV: 'test',
  GOOGLE_CLOUD_PROJECT: 'vayusetu-test',
  PUBSUB_PUSH_AUTH: 'oidc',
  PUBSUB_PUSH_AUDIENCE: 'vayusetu-analysis-service-test',
  PUBSUB_PUSH_SA_EMAIL: PUSH_SA,
});

const { buildApp } = await import('../src/app.js');
type Deps = import('../src/pipeline/analyze.js').AnalysisDeps;
type Outcome = import('../src/pipeline/analyze.js').TriageOutcome;
type Assessment = import('@vayusetu/gemini-client').RecordAirQualityAssessment;

const NOW = new Date('2026-11-03T02:10:00.000Z');

const assessment = (over: Partial<Assessment> = {}): Outcome => ({
  kind: 'assessment',
  modelVersion: 'gemini-3.7-flash',
  raw: { fake: true },
  value: {
    sourceClassification: 'vehicular_smog',
    severityEstimate: 4,
    skyOpacityScore: 0.8,
    plumeDetected: false,
    visibilityMeters: 800,
    confidenceScore: 0.85,
    needsHumanReview: false,
    recommendedAdvisory: 'बाहर व्यायाम से बचें।',
    advisoryLanguage: 'hi-IN',
    ...over,
  },
});
const question = (q = 'क्या धुआँ खेत से आ रहा है?'): Outcome => ({
  kind: 'question', modelVersion: 'gemini-3.7-flash', raw: {}, value: { question: q, language: 'hi-IN' },
});

function makeDeps(triageResponses: Outcome[], over: Partial<Deps> = {}) {
  const triage = vi.fn(async (...args: [unknown, 'assess' | 'clarify']) => {
    void args;
    const next = triageResponses.shift();
    if (!next) throw new Error('unexpected extra triage call');
    return next;
  });
  const publishCompleted = vi.fn(async () => undefined);
  const synthesize = vi.fn(async () => 'gs://audio/tts/hi-IN/abc.mp3');
  const deps: Deps = {
    triage,
    transcribe: vi.fn(async () => 'यहाँ कूड़ा जल रहा है'),
    loadContext: vi.fn(async () => ({
      context: { localTime: '2026-11-03 07:40 IST', season: 'post-monsoon' },
      corridorId: 'ncr-airshed',
      reference: { aqi: 350, source: 'monitor' as const, label: 'monitor anand-vihar (2.1 km)' },
      crossValidation: { nearestMonitorId: 'anand-vihar', nearestMonitorAQI: 350, satelliteAODAtCell: 0.61 },
    })),
    synthesize,
    archiveRaw: vi.fn(async (id: string) => `gs://raw/analysis-raw/${id}/x.json`),
    publishCompleted,
    now: () => NOW,
    logger: { info: () => undefined, warn: () => undefined },
    clarifyBelowConfidence: 0.4,
    ...over,
  };
  return { deps, triage, publishCompleted, synthesize };
}

function seed(over: Partial<Submission> = {}): Submission {
  const sub: Submission = {
    id: 'sub1', userId: 'rina', mediaType: 'photo', photoStorageUrl: 'gs://media/submissions/rina/2026-11-03/photo-1.jpg',
    geo: { lat: 28.6469, lng: 77.316 }, h3Index: '883da1ab2bfffff', jurisdiction: { stateCode: 'DL', districtCode: 'DL-EAST' },
    capturedAt: '2026-11-03T02:09:00.000Z', uploadedAt: '2026-11-03T02:09:30.000Z', status: 'queued', ...over,
  };
  fakeDb.collection('submissions').seed(sub.id, sub as never);
  return sub;
}

const envelope = (payload: unknown) => ({
  message: { data: Buffer.from(JSON.stringify(payload)).toString('base64'), messageId: 'm1' },
});

async function push(app: FastifyInstance, payload: unknown, email = PUSH_SA) {
  return app.inject({
    method: 'POST', url: '/pubsub/submission-created', payload: envelope(payload),
    headers: { authorization: 'Bearer test-token', 'x-test-email': email },
  });
}

async function appWith(deps: Deps) {
  return buildApp({
    deps,
    // The fake verifier trusts the header we choose per test, so we can test both paths.
    pushTokenVerifier: async () => ({ email: currentEmail, email_verified: true }),
  });
}
let currentEmail = PUSH_SA;

const analysis = () => fakeDb.collection('analysisResults').doc('sub1').get().then((s) => s.data() as unknown as AnalysisResult | undefined);
const submission = () => fakeDb.collection('submissions').doc('sub1').get().then((s) => s.data() as unknown as Submission);

beforeEach(() => {
  fakeDb.reset();
  currentEmail = PUSH_SA;
  fakeDb.collection('users').seed('rina', { uid: 'rina', role: 'citizen', preferredLanguage: 'hi-IN', displayName: 'Rina', fcmTokens: [] });
});

describe('Pipeline A happy path', () => {
  it('writes a validated AnalysisResult, TTS audio, and publishes analysis.completed', async () => {
    seed();
    const { deps, publishCompleted, synthesize, triage } = makeDeps([assessment()]);
    const res = await push(await appWith(deps), { submissionId: 'sub1' });

    expect(res.statusCode).toBe(204);
    expect(triage.mock.calls[0]![1]).toBe('assess');
    const a = (await analysis())!;
    expect(a).toMatchObject({
      submissionId: 'sub1', sourceClassification: 'vehicular_smog', severityEstimate: 4, needsHumanReview: false,
      estimatedAQICategory: 'very_poor', // visibility 800 m
      crossValidation: { nearestMonitorId: 'anand-vihar', nearestMonitorAQI: 350, satelliteAODAtCell: 0.61, agreementScore: 1 },
      advisory: { text: 'बाहर व्यायाम से बचें।', language: 'hi-IN', audioStorageUrl: 'gs://audio/tts/hi-IN/abc.mp3' },
      modelVersion: 'gemini-3.7-flash', rawResponseStorageUrl: 'gs://raw/analysis-raw/sub1/x.json',
    });
    expect(synthesize).toHaveBeenCalledWith('बाहर व्यायाम से बचें।', 'hi-IN');
    expect((await submission()).status).toBe('analyzed');
    expect(publishCompleted).toHaveBeenCalledWith({ submissionId: 'sub1', h3Index: '883da1ab2bfffff', corridorId: 'ncr-airshed' });
  });

  it('transcribes a voice note once and passes it to the model', async () => {
    seed({ mediaType: 'photo_audio', audioStorageUrl: 'gs://media/submissions/rina/a.webm' });
    const { deps, triage } = makeDeps([assessment()]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    expect(deps.transcribe).toHaveBeenCalledWith('gs://media/submissions/rina/a.webm', 'hi-IN');
    expect(triage.mock.calls[0]![0]).toMatchObject({ transcript: 'यहाँ कूड़ा जल रहा है' });
    expect((await submission()).transcript).toBe('यहाँ कूड़ा जल रहा है');
  });

  it("passes a field worker's handheld sensor reading to the model", async () => {
    // 30 Sep live check: the reading was stored and displayed but never reached Gemini.
    seed({ fieldSensorReading: { pm25: 182, pm10: 260 } });
    const { deps, triage } = makeDeps([assessment()]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    expect(triage.mock.calls[0]![0]).toMatchObject({ fieldSensor: { pm25: 182, pm10: 260 } });
  });

  it('forces human review when the photo and the reference AQI are > 2 categories apart', async () => {
    seed();
    // no visible pollution (good) vs monitor 350 (very_poor): 4 categories apart
    const { deps } = makeDeps([assessment({ sourceClassification: 'no_visible_pollution', severityEstimate: 1, visibilityMeters: 15000 })]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    const a = (await analysis())!;
    expect(a.needsHumanReview).toBe(true);
    expect(a.reviewNote).toContain('4 categories apart');
    expect(a.crossValidation?.agreementScore).toBe(0.2);
    expect((await submission()).status).toBe('flagged_for_review');
  });
});

describe('language normalisation (found live: bare "en" broke TTS)', () => {
  it('a user stored as "en" gets en-IN for Gemini, TTS and the advisory', async () => {
    fakeDb.collection('users').seed('rina', { uid: 'rina', role: 'citizen', preferredLanguage: 'en', displayName: 'Rina', fcmTokens: [] });
    seed();
    const { deps, triage, synthesize } = makeDeps([assessment({ recommendedAdvisory: 'Avoid outdoor exercise.' })]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    expect(triage.mock.calls[0]![0]).toMatchObject({ advisoryLanguage: 'en-IN' });
    expect(synthesize).toHaveBeenCalledWith('Avoid outdoor exercise.', 'en-IN');
    expect((await analysis())!.advisory.language).toBe('en-IN');
  });
});

describe('resilience', () => {
  it('Speech-to-Text and context failures degrade instead of failing the report', async () => {
    seed({ mediaType: 'photo_audio', audioStorageUrl: 'gs://m/a.webm' });
    const { deps, publishCompleted } = makeDeps([assessment()], {
      transcribe: vi.fn(async () => {
        throw new Error('stt down');
      }),
      loadContext: vi.fn(async () => {
        throw new Error('bq down');
      }),
    });
    const res = await push(await appWith(deps), { submissionId: 'sub1' });
    expect(res.statusCode).toBe(204);
    const a = (await analysis())!;
    expect(a.sourceClassification).toBe('vehicular_smog');
    expect(a.crossValidation?.agreementScore).toBeUndefined();
    // no corridor known without context -> not published, but analysis stands
    expect(publishCompleted).not.toHaveBeenCalled();
  });

  it('invalid model output twice -> status failed, no AnalysisResult, message acked', async () => {
    seed();
    const bad: Outcome = { kind: 'invalid', error: 'schema', raw: {} };
    const { deps } = makeDeps([bad, { ...bad }]);
    const res = await push(await appWith(deps), { submissionId: 'sub1' });
    expect(res.statusCode).toBe(204);
    expect(await analysis()).toBeUndefined();
    expect((await submission()).status).toBe('failed');
  });

  it('invalid once then valid -> analyzed', async () => {
    seed();
    const { deps } = makeDeps([{ kind: 'invalid', error: 'schema', raw: {} }, assessment()]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    expect((await submission()).status).toBe('analyzed');
  });

  it('a transient triage error nacks (500) for redelivery', async () => {
    seed();
    const { deps } = makeDeps([], {
      triage: vi.fn(async () => {
        throw Object.assign(new Error('503'), { status: 503 });
      }),
    });
    expect((await push(await appWith(deps), { submissionId: 'sub1' })).statusCode).toBe(500);
    expect((await submission()).status).toBe('pending_analysis'); // redelivery will process it
  });

  it('a redelivered event for a finished report is skipped (no second Gemini bill)', async () => {
    seed({ status: 'analyzed' });
    const { deps, triage } = makeDeps([]);
    expect((await push(await appWith(deps), { submissionId: 'sub1' })).statusCode).toBe(204);
    expect(triage).not.toHaveBeenCalled();
  });

  it('retry-analysis (status reset to pending_analysis) re-runs', async () => {
    seed({ status: 'pending_analysis' });
    const { deps, triage } = makeDeps([assessment()]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    expect(triage).toHaveBeenCalledTimes(1);
  });
});

describe('Pipeline D clarification', () => {
  const unclear = () => assessment({ sourceClassification: 'indeterminate', confidenceScore: 0.2, severityEstimate: 2, visibilityMeters: undefined });

  it('indeterminate + low confidence -> one question, no analysis.completed yet', async () => {
    seed();
    const { deps, triage, publishCompleted } = makeDeps([unclear(), question()]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    expect(triage.mock.calls.map((c) => c[1])).toEqual(['assess', 'clarify']);
    const a = (await analysis())!;
    expect(a.pendingClarification).toEqual({ turn: 1, question: 'क्या धुआँ खेत से आ रहा है?', language: 'hi-IN' });
    expect(a.needsHumanReview).toBe(true);
    const s = await submission();
    expect(s.status).toBe('flagged_for_review');
    expect(s.clarifications).toEqual([{ turn: 1, question: 'क्या धुआँ खेत से आ रहा है?', language: 'hi-IN', askedAt: NOW.toISOString() }]);
    expect(publishCompleted).not.toHaveBeenCalled();
  });

  it('an answered question re-runs in clarify mode with the exchange as context', async () => {
    seed({
      status: 'pending_analysis',
      clarifications: [{ turn: 1, question: 'Field or chimney?', language: 'hi-IN', askedAt: 't', answerText: 'खेत', answeredAt: 't2' }],
    });
    const { deps, triage } = makeDeps([assessment({ sourceClassification: 'crop_residue_burning' })]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    expect(triage.mock.calls[0]![1]).toBe('clarify');
    expect(triage.mock.calls[0]![0]).toMatchObject({ clarifications: [{ question: 'Field or chimney?', answerText: 'खेत' }] });
    const a = (await analysis())!;
    expect(a.sourceClassification).toBe('crop_residue_burning');
    expect(a.pendingClarification).toBeUndefined();
    expect((await submission()).clarifications).toHaveLength(1);
  });

  it('after two turns still unclear -> recorded as unclassified for review', async () => {
    const turn = (n: 1 | 2) => ({ turn: n, question: `q${n}`, language: 'hi-IN', askedAt: 't', answerText: 'pata nahi', answeredAt: 't' });
    seed({ status: 'pending_analysis', clarifications: [turn(1), turn(2)] });
    const { deps, triage } = makeDeps([unclear()]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    expect(triage).toHaveBeenCalledTimes(1); // no third question
    const a = (await analysis())!;
    expect(a.sourceClassification).toBe('indeterminate');
    expect(a.needsHumanReview).toBe(true);
    expect(a.reviewNote).toContain('Recorded as unclassified');
  });

  it('confident indeterminate (e.g. indoor photo) is final -- no question asked', async () => {
    seed();
    const { deps, triage } = makeDeps([assessment({ sourceClassification: 'indeterminate', confidenceScore: 0.6 })]);
    await push(await appWith(deps), { submissionId: 'sub1' });
    expect(triage).toHaveBeenCalledTimes(1);
  });
});

describe('push route', () => {
  it('rejects a push signed for another service account', async () => {
    seed();
    const { deps, triage } = makeDeps([assessment()]);
    const app = await appWith(deps);
    currentEmail = 'attacker@evil.iam.gserviceaccount.com';
    expect((await push(app, { submissionId: 'sub1' })).statusCode).toBe(401);
    expect(triage).not.toHaveBeenCalled();
  });

  it('acks (drops) contract-violating payloads and unknown submissions', async () => {
    const { deps } = makeDeps([]);
    const app = await appWith(deps);
    expect((await push(app, { wrong: 1 })).statusCode).toBe(204);
    expect((await push(app, { submissionId: 'ghost' })).statusCode).toBe(204);
  });
});
