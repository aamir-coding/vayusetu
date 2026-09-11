import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Submission, User } from '@vayusetu/shared-types';
import { analysisResultsCollection, submissionsCollection, usersCollection } from '../lib/collections.js';
import { requireAuthUser } from '../plugins/auth.js';
import { ApiHttpError } from '../lib/errors.js';
import { resolveJurisdiction } from '../lib/reverseGeocode.js';
import { resolveH3Index } from '../lib/h3.js';
import { publishSubmissionCreated } from '../lib/publishEvent.js';
import { jurisdictionContains } from '../lib/jurisdiction.js';

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

const CreateSubmissionSchema = z.object({
  mediaType: z.enum(['photo', 'photo_audio']),
  photoStorageUrl: z.string().url(),
  audioStorageUrl: z.string().url().optional(),
  geo: GeoPointSchema,
  capturedAt: z.string().min(1),
  deviceMeta: DeviceMetaSchema,
});

/** Mirrors apps/citizen-pwa/src/mocks/handlers.ts's exact behavior: a
 *  citizen/field worker who hasn't called ensureRegistered() yet gets a
 *  401, not a 500 -- POST /submissions should never be the first call a
 *  new account makes. */
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
  const user = requester.data()!;
  if (user.role === 'citizen' || user.role === 'field_worker') return false;
  if (!user.jurisdiction) return false;
  return jurisdictionContains(user.jurisdiction, submission.jurisdiction);
}

export default async function submissionsRoutes(app: FastifyInstance) {
  app.post('/submissions', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    await requireOwnUser(uid);

    const body = CreateSubmissionSchema.parse(request.body);

    const [jurisdiction, h3Index] = await Promise.all([
      resolveJurisdiction(body.geo),
      Promise.resolve(resolveH3Index(body.geo)),
    ]);

    const ref = submissionsCollection().doc();
    const now = new Date().toISOString();
    const submission: Submission = {
      id: ref.id,
      userId: uid,
      mediaType: body.mediaType,
      photoStorageUrl: body.photoStorageUrl,
      ...(body.audioStorageUrl ? { audioStorageUrl: body.audioStorageUrl } : {}),
      geo: body.geo,
      h3Index,
      jurisdiction,
      capturedAt: body.capturedAt,
      uploadedAt: now,
      status: 'queued',
      ...(body.deviceMeta ? { deviceMeta: body.deviceMeta } : {}),
    };
    await ref.set(submission);

    try {
      await publishSubmissionCreated(submission.id);
    } catch (error) {
      // The Submission is durably written; a failed publish just means
      // analysis-service never picks it up automatically. Log loudly
      // rather than fail the citizen's request over it -- losing a photo
      // the citizen thinks they successfully sent is worse than a report
      // that needs POST /submissions/:id/retry-analysis later.
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
    reply.send({ submission, analysis: analysisSnap.exists ? analysisSnap.data() : null });
  });

  app.get('/submissions', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const query = request.query as Record<string, string | undefined>;
    const pageSize = Math.min(Number(query.pageSize) || 20, 100);

    const requester = await requireOwnUser(uid);

    let q = submissionsCollection().orderBy('uploadedAt', 'desc').limit(pageSize);

    if (requester.role === 'citizen' || requester.role === 'field_worker') {
      // Never client-filtered (API_CONTRACTS.md's repeated jurisdiction
      // rule, applied to the citizen case): a citizen only ever sees
      // their own reports, regardless of any ?userId= they pass.
      q = submissionsCollection().where('userId', '==', uid).orderBy('uploadedAt', 'desc').limit(pageSize);
    } else if (requester.jurisdiction) {
      q = q.where('jurisdiction.stateCode', '==', requester.jurisdiction.stateCode);
      if (requester.jurisdiction.districtCode) {
        q = q.where('jurisdiction.districtCode', '==', requester.jurisdiction.districtCode);
      }
    }

    if (query.status) q = q.where('status', '==', query.status);
    if (query.h3Index) q = q.where('h3Index', '==', query.h3Index);
    if (query.pageToken) {
      const cursor = JSON.parse(Buffer.from(query.pageToken, 'base64url').toString('utf-8')) as {
        uploadedAt: string;
      };
      q = q.startAfter(cursor.uploadedAt);
    }

    const snap = await q.get();
    const items = snap.docs.map((doc) => doc.data());
    const last = items.at(-1);
    const nextPageToken = last
      ? Buffer.from(JSON.stringify({ uploadedAt: last.uploadedAt })).toString('base64url')
      : undefined;

    reply.send({ items, nextPageToken, totalCount: items.length });
  });

  app.post('/submissions/:id/retry-analysis', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const { id } = request.params as { id: string };

    const ref = submissionsCollection().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'Submission not found');
    const submission = snap.data()!;

    const isOwner = submission.userId === uid;
    if (!isOwner) {
      const requesterSnap = await usersCollection().doc(uid).get();
      const requester = requesterSnap.exists ? requesterSnap.data()! : undefined;
      const isOfficial = requester && requester.role !== 'citizen' && requester.role !== 'field_worker';
      const allowed =
        isOfficial && requester.jurisdiction && jurisdictionContains(requester.jurisdiction, submission.jurisdiction);
      if (!allowed) throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Outside your assigned jurisdiction');
    }

    if (submission.status === 'analyzed') {
      throw new ApiHttpError('CONFLICT', 'Already analyzed');
    }

    const updated: Submission = { ...submission, status: 'pending_analysis' };
    await ref.set(updated);
    await publishSubmissionCreated(updated.id);

    reply.status(202).send({ submission: updated });
  });
}
