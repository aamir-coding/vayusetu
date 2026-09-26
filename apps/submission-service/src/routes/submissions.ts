import type { FastifyInstance } from 'fastify';
import type { Query } from 'firebase-admin/firestore';
import { z } from 'zod';
import { GeocodingError } from '@vayusetu/gcp-clients';
import type { AnalysisResult, ClarificationExchange, Jurisdiction, Paginated, Submission, User } from '@vayusetu/shared-types';
import { analysisResultsCollection, submissionsCollection, usersCollection } from '../lib/collections.js';
import { requireAuthUser } from '../plugins/auth.js';
import { ApiHttpError } from '../lib/errors.js';
import { jurisdictionResolver } from '../lib/reverseGeocode.js';
import { resolveH3Index } from '../lib/h3.js';
import { publishSubmissionCreated } from '../lib/publishEvent.js';
import { jurisdictionContains } from '../lib/jurisdiction.js';
import { env } from '../config/env.js';
import { mediaPrefixFor } from './uploads.js';
import { decodePageToken, encodePageToken, officialScope, withPlayableAudio } from '../lib/scope.js';

const GeoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const DeviceMetaSchema = z
  .object({
    platform: z.enum(['android', 'ios', 'web']),
    appVersion: z.string(),
    networkType: z.enum(['2g', '3g', '4g', '5g', 'wifi', 'unknown']).optional(),
  })
  .optional();

const CreateSubmissionSchema = z
  .object({
    mediaType: z.enum(['photo', 'photo_audio']),
    photoStorageUrl: z.string().url(),
    audioStorageUrl: z.string().url().optional(),
    geo: GeoPointSchema,
    capturedAt: z.string().datetime({ offset: true }),
    deviceMeta: DeviceMetaSchema,
    // Persona 2's handheld sensor (Product Spec Feature 1), ug/m3.
    fieldSensorReading: z
      .object({ pm25: z.number().min(0).max(2000).optional(), pm10: z.number().min(0).max(2000).optional() })
      .refine((r) => r.pm25 !== undefined || r.pm10 !== undefined, 'provide pm25 and/or pm10')
      .optional(),
  })
  .refine((b) => b.mediaType !== 'photo_audio' || Boolean(b.audioStorageUrl), {
    path: ['audioStorageUrl'],
    message: 'audioStorageUrl is required when mediaType is photo_audio',
  });

const ClarifyBodySchema = z
  .object({
    answerText: z.string().trim().min(1).max(500).optional(),
    answerPhotoStorageUrl: z.string().url().optional(),
  })
  .refine((b) => b.answerText || b.answerPhotoStorageUrl, 'Provide answerText and/or answerPhotoStorageUrl');

const SUBMISSION_STATUSES = ['queued', 'uploading', 'pending_analysis', 'analyzed', 'failed', 'flagged_for_review'] as const;

const ListQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  status: z.enum(SUBMISSION_STATUSES).optional(),
  h3Index: z.string().regex(/^[0-9a-f]{15}$/i, 'must be an H3 index').optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  pageToken: z.string().optional(),
});

async function requireOwnUser(uid: string): Promise<User> {
  const snap = await usersCollection().doc(uid).get();
  if (!snap.exists) {
    throw new ApiHttpError('UNAUTHORIZED', 'Register before submitting a report');
  }
  return snap.data()!;
}

async function canReadSubmission(requesterUid: string, submission: Submission): Promise<boolean> {
  if (submission.userId === requesterUid) return true;
  const requester = await usersCollection().doc(requesterUid).get();
  if (!requester.exists) return false;
  const scope = officialScope(requester.data()!);
  if (scope === 'all') return true;
  if (!scope) return false;
  return jurisdictionContains(scope, submission.jurisdiction);
}

/**
 * Only media this caller uploaded through POST /submissions/upload-url is
 * accepted. Without this, a client could register another citizen's object
 * -- or an arbitrary external URL that analysis-service would then hand to
 * Gemini. Skipped (with the bucket unset) only in local dev.
 */
function assertOwnMedia(uid: string, url: string | undefined, field: string) {
  if (!url || !env.MEDIA_BUCKET) return;
  const prefix = `gs://${env.MEDIA_BUCKET}/${mediaPrefixFor(uid)}`;
  if (!url.startsWith(prefix)) {
    throw new ApiHttpError('VALIDATION_ERROR', `${field} must be a URL issued by POST /submissions/upload-url`, {
      field,
      expectedPrefix: prefix,
    });
  }
}

export default async function submissionsRoutes(app: FastifyInstance) {
  app.post('/submissions', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const user = await requireOwnUser(uid);
    if (user.role !== 'citizen' && user.role !== 'field_worker') {
      throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Only citizens and field workers submit reports');
    }

    const body = CreateSubmissionSchema.parse(request.body);
    assertOwnMedia(uid, body.photoStorageUrl, 'photoStorageUrl');
    assertOwnMedia(uid, body.audioStorageUrl, 'audioStorageUrl');

    let jurisdiction: Jurisdiction;
    try {
      jurisdiction = await jurisdictionResolver.resolve(body.geo);
    } catch (error) {
      if (error instanceof GeocodingError && error.kind === 'no_result') {
        throw new ApiHttpError('VALIDATION_ERROR', 'This location could not be matched to a jurisdiction');
      }
      // Transient or config failure: never guess a jurisdiction -- a
      // misrouted report is worse than a retried one. The PWA's offline
      // queue retries 5xx automatically.
      request.log.error({ err: error }, 'Jurisdiction resolution failed');
      throw new ApiHttpError('INTERNAL_ERROR', 'Could not resolve jurisdiction right now, please retry');
    }

    const ref = submissionsCollection().doc();
    const now = new Date().toISOString();
    const submission: Submission = {
      id: ref.id,
      userId: uid,
      mediaType: body.mediaType,
      photoStorageUrl: body.photoStorageUrl,
      ...(body.audioStorageUrl ? { audioStorageUrl: body.audioStorageUrl } : {}),
      geo: body.geo,
      h3Index: resolveH3Index(body.geo),
      jurisdiction,
      capturedAt: body.capturedAt,
      uploadedAt: now,
      status: 'queued',
      ...(body.deviceMeta ? { deviceMeta: body.deviceMeta } : {}),
      // Honoured for field workers only (contract); a citizen's is dropped.
      ...(body.fieldSensorReading && user.role === 'field_worker' ? { fieldSensorReading: body.fieldSensorReading } : {}),
    };
    await ref.set(submission);

    try {
      await publishSubmissionCreated(submission.id);
    } catch (error) {
      // Durably written; a failed publish only means analysis-service won't
      // pick it up automatically. Don't fail the citizen's request over it --
      // POST /submissions/:id/retry-analysis recovers it.
      request.log.error({ err: error, submissionId: submission.id }, 'submission.created publish failed');
    }

    reply.status(202).send({ submission });
  });

  app.get('/submissions/:id', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const { id } = request.params as { id: string };

    const snap = await submissionsCollection().doc(id).get();
    if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'Submission not found');
    const submission = snap.data()!;

    if (!(await canReadSubmission(uid, submission))) {
      throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Outside your assigned jurisdiction');
    }

    const analysisSnap = await analysisResultsCollection().doc(id).get();
    const analysis = await withPlayableAudio(analysisSnap.exists ? analysisSnap.data()! : null, request.log);
    reply.send({ submission, analysis });
  });

  // GET /analysis/:submissionId -- same authorization as the parent submission.
  // Clients poll this while status is pending_analysis (or listen on Firestore).
  app.get('/analysis/:submissionId', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const { submissionId } = request.params as { submissionId: string };
    const snap = await submissionsCollection().doc(submissionId).get();
    if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'Submission not found');
    const submission = snap.data()!;
    if (!(await canReadSubmission(uid, submission))) {
      throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Outside your assigned jurisdiction');
    }
    const analysisSnap = await analysisResultsCollection().doc(submissionId).get();
    const result = await withPlayableAudio(analysisSnap.exists ? analysisSnap.data()! : null, request.log);
    reply.send({ status: submission.status, result });
  });

  // POST /submissions/:id/clarify -- the citizen's answer to Pipeline D's question.
  app.post('/submissions/:id/clarify', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const { id } = request.params as { id: string };
    const body = ClarifyBodySchema.parse(request.body);
    assertOwnMedia(uid, body.answerPhotoStorageUrl, 'answerPhotoStorageUrl');

    const ref = submissionsCollection().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'Submission not found');
    const submission = snap.data()!;
    if (submission.userId !== uid) throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Only the reporter can answer');

    const analysisSnap = await analysisResultsCollection().doc(id).get();
    const pending = analysisSnap.exists ? (analysisSnap.data() as AnalysisResult).pendingClarification : undefined;
    const clarifications: ClarificationExchange[] = [...(submission.clarifications ?? [])];
    const exchange = pending ? clarifications.find((c) => c.turn === pending.turn) : undefined;
    if (!pending || !exchange || exchange.answeredAt) {
      throw new ApiHttpError('CONFLICT', 'No clarifying question is waiting for an answer');
    }
    Object.assign(exchange, {
      ...(body.answerText ? { answerText: body.answerText } : {}),
      ...(body.answerPhotoStorageUrl ? { answerPhotoStorageUrl: body.answerPhotoStorageUrl } : {}),
      answeredAt: new Date().toISOString(),
    });
    await ref.update({ clarifications, status: 'pending_analysis' });
    await publishSubmissionCreated(id);
    reply.status(202).send({ submission: { ...submission, clarifications, status: 'pending_analysis' } });
  });

  app.get('/submissions', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const query = ListQuerySchema.parse(request.query);
    const requester = await requireOwnUser(uid);

    let q: Query<Submission> = submissionsCollection();
    const scope = officialScope(requester);

    if (scope === null) {
      // Citizens / field workers: ALWAYS their own reports. ?userId is
      // ignored rather than trusted -- never client-filtered.
      q = q.where('userId', '==', uid);
    } else {
      if (scope !== 'all') {
        q = q.where('jurisdiction.stateCode', '==', scope.stateCode);
        if (scope.districtCode) q = q.where('jurisdiction.districtCode', '==', scope.districtCode);
      }
      if (query.userId) q = q.where('userId', '==', query.userId);
    }
    if (query.status) q = q.where('status', '==', query.status);
    if (query.h3Index) q = q.where('h3Index', '==', query.h3Index);

    // Real total for the filter, not the page length (Week 1 returned
    // items.length, which the UI would have shown as "N reports").
    const totalCount = (await q.count().get()).data().count;

    let page = q.orderBy('uploadedAt', 'desc').limit(query.pageSize);
    if (query.pageToken) {
      // Cursor on the document snapshot, not the uploadedAt value, so two
      // reports with the same millisecond timestamp are never skipped.
      const cursorSnap = await submissionsCollection().doc(decodePageToken(query.pageToken)).get();
      if (!cursorSnap.exists) throw new ApiHttpError('VALIDATION_ERROR', 'pageToken refers to a deleted item');
      page = page.startAfter(cursorSnap);
    }

    const snap = await page.get();
    const items = snap.docs.map((doc) => doc.data());
    const body: Paginated<Submission> = {
      items,
      totalCount,
      // Only when the page is full -- Week 1 always returned a token, so the
      // client's last "load more" fetched an empty page.
      ...(items.length === query.pageSize ? { nextPageToken: encodePageToken(snap.docs.at(-1)!.id) } : {}),
    };
    reply.send(body);
  });

  app.post('/submissions/:id/retry-analysis', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const { id } = request.params as { id: string };

    const ref = submissionsCollection().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'Submission not found');
    const submission = snap.data()!;

    if (submission.userId !== uid) {
      const requesterSnap = await usersCollection().doc(uid).get();
      const scope = requesterSnap.exists ? officialScope(requesterSnap.data()!) : null;
      const allowed = scope === 'all' || (scope !== null && jurisdictionContains(scope, submission.jurisdiction));
      if (!allowed) throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Outside your assigned jurisdiction');
    }

    // Contract: 409 when "already analyzed and not flagged for review".
    if (submission.status === 'analyzed') {
      throw new ApiHttpError('CONFLICT', 'Already analyzed');
    }

    // update(), not set(): a whole-doc write could clobber a concurrent
    // analysis-service write (transcript, clarifications).
    await ref.update({ status: 'pending_analysis' });
    const updated: Submission = { ...submission, status: 'pending_analysis' };
    await publishSubmissionCreated(updated.id);

    reply.status(202).send({ submission: updated });
  });
}
