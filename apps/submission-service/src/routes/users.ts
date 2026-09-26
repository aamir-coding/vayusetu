import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { User } from '@vayusetu/shared-types';
import { usersCollection } from '../lib/collections.js';
import { requireAuthUser } from '../plugins/auth.js';
import { ApiHttpError } from '../lib/errors.js';

const RegisterBodySchema = z.object({
  displayName: z.string().min(1).max(120),
  preferredLanguage: z.string().min(2).max(10),
  role: z.enum(['citizen', 'field_worker']),
});

const UpdateBodySchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    preferredLanguage: z.string().min(2).max(10).optional(),
    // Officials' dashboards register FCM tokens here (alert-service reads
    // them). De-duplicate and keep the 10 most recent: tokens accumulate per
    // browser/device, and every stale one costs a failed send per alert.
    fcmTokens: z
      .array(z.string().min(20).max(4096))
      .max(50)
      .transform((tokens) => [...new Set(tokens)].slice(-10))
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field to update' });

export default async function usersRoutes(app: FastifyInstance) {
  // POST /users/register -- district_admin+/state_admin+/super_admin accounts
  // are provisioned out-of-band by a super_admin (API_CONTRACTS.md §4.2),
  // never through this endpoint.
  app.post('/users/register', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const body = RegisterBodySchema.parse(request.body);

    const ref = usersCollection().doc(uid);
    const existing = await ref.get();
    if (existing.exists) {
      throw new ApiHttpError('CONFLICT', 'Profile already exists');
    }

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
    await ref.set(user);
    reply.status(201).send(user);
  });

  app.get('/users/me', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const snap = await usersCollection().doc(uid).get();
    if (!snap.exists) {
      throw new ApiHttpError('NOT_FOUND', 'No profile registered for this account yet');
    }
    reply.send(snap.data());
  });

  app.patch('/users/me', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const patch = UpdateBodySchema.parse(request.body);

    const ref = usersCollection().doc(uid);
    const snap = await ref.get();
    if (!snap.exists) {
      // Not explicitly enumerated in API_CONTRACTS.md's error list for
      // this endpoint (only 400/401 are listed), but this is the correct
      // defensive behavior for a doc that genuinely doesn't exist.
      throw new ApiHttpError('NOT_FOUND', 'No profile registered for this account yet');
    }

    await ref.set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
    const fresh = await ref.get();
    reply.send(fresh.data());
  });
}
