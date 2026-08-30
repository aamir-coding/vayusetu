import { HttpResponse, http } from 'msw';
import type { AnalysisResult, Paginated, Submission, User } from '@vayusetu/shared-types';
import { DEFAULT_JURISDICTION, db, extractUid, fabricateAnalysis, getOrThrowUser, nextSubmissionId } from './fixtures';

const err = (code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status: code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 500 });

export const handlers = [
  // ---------- Users ----------
  http.post('*/api/v1/users/register', async ({ request }) => {
    const uid = extractUid(request.headers.get('authorization'));
    if (db.users.has(uid)) return err('CONFLICT', 'Profile already exists');
    const body = (await request.json()) as Pick<User, 'displayName' | 'preferredLanguage' | 'role'>;
    const now = new Date().toISOString();
    const user: User = {
      uid,
      displayName: body.displayName,
      preferredLanguage: body.preferredLanguage,
      role: body.role,
      fcmTokens: [],
      createdAt: now,
      updatedAt: now,
    };
    db.users.set(uid, user);
    return HttpResponse.json(user, { status: 201 });
  }),

  http.get('*/api/v1/users/me', ({ request }) => {
    const uid = extractUid(request.headers.get('authorization'));
    const user = db.users.get(uid);
    if (!user) return err('NOT_FOUND', 'No profile registered for this account yet');
    return HttpResponse.json(user);
  }),

  http.patch('*/api/v1/users/me', async ({ request }) => {
    const uid = extractUid(request.headers.get('authorization'));
    const user = db.users.get(uid);
    if (!user) return err('NOT_FOUND', 'No profile registered for this account yet');
    const patch = (await request.json()) as Partial<Pick<User, 'displayName' | 'preferredLanguage' | 'fcmTokens'>>;
    const updated: User = { ...user, ...patch, updatedAt: new Date().toISOString() };
    db.users.set(uid, updated);
    return HttpResponse.json(updated);
  }),

  // ---------- Mock storage (signed-URL stand-in for Cloud Storage) ----------
  http.get('/mock-storage/sign', ({ request }) => {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') ?? `obj-${Date.now()}`;
    return HttpResponse.json({
      uploadUrl: `/mock-storage/put/${id}`,
      storageUrl: `https://storage.mock.vayusetu.local/citizen-media/${id}`,
    });
  }),
  http.put('/mock-storage/put/:id', () => HttpResponse.json({ ok: true })),

  // ---------- Submissions ----------
  http.post('*/api/v1/submissions', async ({ request }) => {
    const uid = extractUid(request.headers.get('authorization'));
    let user: User;
    try {
      user = getOrThrowUser(uid);
    } catch {
      return err('UNAUTHORIZED', 'Register before submitting a report');
    }
    const body = (await request.json()) as Omit<Submission, 'id' | 'userId' | 'h3Index' | 'jurisdiction' | 'uploadedAt' | 'status'>;
    const now = new Date().toISOString();
    const submission: Submission = {
      id: nextSubmissionId(),
      userId: user.uid,
      mediaType: body.mediaType,
      photoStorageUrl: body.photoStorageUrl,
      audioStorageUrl: body.audioStorageUrl,
      geo: body.geo,
      h3Index: '8a1fb46622dffff', // mock res-8 cell; real value comes from analysis-service's reverse-geocode step
      jurisdiction: DEFAULT_JURISDICTION,
      capturedAt: body.capturedAt,
      uploadedAt: now,
      status: 'queued',
      deviceMeta: body.deviceMeta,
    };
    db.submissions.set(submission.id, submission);

    // Simulate submission-service -> analysis-service's async pipeline.
    setTimeout(() => {
      const analyzing = db.submissions.get(submission.id);
      if (analyzing) db.submissions.set(submission.id, { ...analyzing, status: 'pending_analysis' });
    }, 400);
    setTimeout(() => {
      const current = db.submissions.get(submission.id);
      if (!current) return;
      const result = fabricateAnalysis(current);
      db.analysisResults.set(submission.id, result);
      db.submissions.set(submission.id, {
        ...current,
        status: result.needsHumanReview ? 'flagged_for_review' : 'analyzed',
      });
    }, 3200);

    return HttpResponse.json({ submission }, { status: 202 });
  }),

  http.get('*/api/v1/submissions/:id', ({ params }) => {
    const submission = db.submissions.get(params.id as string);
    if (!submission) return err('NOT_FOUND', 'Submission not found');
    const analysis = db.analysisResults.get(submission.id) ?? null;
    return HttpResponse.json({ submission, analysis });
  }),

  http.get('*/api/v1/submissions', ({ request }) => {
    const uid = extractUid(request.headers.get('authorization'));
    const url = new URL(request.url);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
    const all = Array.from(db.submissions.values())
      .filter((s) => s.userId === uid)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    const items = all.slice(0, pageSize);
    const body: Paginated<Submission> = { items, totalCount: all.length };
    return HttpResponse.json(body);
  }),

  http.post('*/api/v1/submissions/:id/retry-analysis', ({ params }) => {
    const submission = db.submissions.get(params.id as string);
    if (!submission) return err('NOT_FOUND', 'Submission not found');
    if (submission.status === 'analyzed') return err('CONFLICT', 'Already analyzed');
    const updated: Submission = { ...submission, status: 'pending_analysis' };
    db.submissions.set(updated.id, updated);
    setTimeout(() => {
      const result = fabricateAnalysis(updated);
      db.analysisResults.set(updated.id, result);
      db.submissions.set(updated.id, { ...updated, status: result.needsHumanReview ? 'flagged_for_review' : 'analyzed' });
    }, 2000);
    return HttpResponse.json({ submission: updated }, { status: 202 });
  }),

  // ---------- Analysis ----------
  http.get('*/api/v1/analysis/:submissionId', ({ params }) => {
    const submission = db.submissions.get(params.submissionId as string);
    if (!submission) return err('NOT_FOUND', 'Submission not found');
    const result: AnalysisResult | null = db.analysisResults.get(submission.id) ?? null;
    return HttpResponse.json({ status: submission.status, result });
  }),
];
