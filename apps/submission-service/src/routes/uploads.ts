import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createSignedUploadUrl } from '@vayusetu/gcp-clients';
import { env } from '../config/env.js';
import { requireAuthUser } from '../plugins/auth.js';
import { ApiHttpError } from '../lib/errors.js';
import { usersCollection } from '../lib/collections.js';

/**
 * PROPOSED CONTRACT ADDITION -- not yet in API_CONTRACTS.md §4.2.
 *
 * The POST /submissions contract says media is uploaded "via a signed URL
 * obtained beforehand", but none of the 23 endpoints issues one;
 * apps/citizen-pwa/src/lib/uploadClient.ts is still calling an MSW-only
 * `/mock-storage/sign`. The response shape deliberately matches what that
 * client already expects ({ uploadUrl, storageUrl }) plus `expiresAt`, so
 * Engineer 1's change is a URL swap. The proposed contract text is in
 * WEEK2_SETUP.md; do not treat this as final until it's merged there.
 */

const CONTENT_TYPES = {
  photo: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  audio: { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' },
} as const;

const BodySchema = z
  .object({
    kind: z.enum(['photo', 'audio']),
    // Browsers append parameters (e.g. "audio/webm;codecs=opus"). Accept them,
    // but sign exactly what the client will send as its Content-Type header.
    contentType: z.string().min(3).max(100),
  })
  .superRefine((body, ctx) => {
    const base = body.contentType.split(';')[0]!.trim().toLowerCase();
    if (!(base in CONTENT_TYPES[body.kind])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentType'],
        message: `Unsupported ${body.kind} content type "${base}"`,
      });
    }
  });

/** Every object lives under the uploader's uid, which lets POST /submissions
 *  reject a storage URL the caller didn't upload themselves. */
export function mediaPrefixFor(uid: string): string {
  return `submissions/${uid}/`;
}

export default async function uploadsRoutes(app: FastifyInstance) {
  app.post('/submissions/upload-url', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const body = BodySchema.parse(request.body);

    const user = await usersCollection().doc(uid).get();
    if (!user.exists) throw new ApiHttpError('UNAUTHORIZED', 'Register before uploading media');
    const role = user.data()!.role;
    if (role !== 'citizen' && role !== 'field_worker') {
      throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Only citizens and field workers upload report media');
    }

    if (!env.MEDIA_BUCKET) {
      throw new ApiHttpError(
        'INTERNAL_ERROR',
        'MEDIA_BUCKET is not configured on submission-service (Terraform output: citizen_media_bucket)',
      );
    }

    const base = body.contentType.split(';')[0]!.trim().toLowerCase();
    const extensions: Record<string, string> = CONTENT_TYPES[body.kind];
    const ext = extensions[base]!; // guaranteed by BodySchema's superRefine
    const day = new Date().toISOString().slice(0, 10);
    const objectPath = `${mediaPrefixFor(uid)}${day}/${body.kind}-${randomUUID()}.${ext}`;

    const signed = await createSignedUploadUrl({
      bucket: env.MEDIA_BUCKET,
      objectPath,
      contentType: body.contentType,
    });
    reply.status(200).send(signed);
  });
}
