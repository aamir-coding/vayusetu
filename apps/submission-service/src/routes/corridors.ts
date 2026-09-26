import type { FastifyInstance } from 'fastify';
import type { Corridor } from '@vayusetu/shared-types';
import { corridorsCollection } from '../lib/collections.js';
import { requireAuthUser } from '../plugins/auth.js';
import { ApiHttpError } from '../lib/errors.js';

/**
 * Corridors (reference/config) -- API_CONTRACTS.md 4.2. Read-only here: the
 * documents are written by the ingestion `seed` job from data/seed/, the one
 * canonical registry. Any authenticated user may read them.
 */
export default async function corridorsRoutes(app: FastifyInstance) {
  app.get('/corridors', async (request, reply) => {
    requireAuthUser(request);
    const snap = await corridorsCollection().get();
    const corridors: Corridor[] = snap.docs.map((d) => d.data()).sort((a, b) => a.id.localeCompare(b.id));
    reply.send({ corridors });
  });

  app.get('/corridors/:id', async (request, reply) => {
    requireAuthUser(request);
    const { id } = request.params as { id: string };
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new ApiHttpError('NOT_FOUND', 'Corridor not found');
    const snap = await corridorsCollection().doc(id).get();
    if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'Corridor not found');
    reply.send(snap.data());
  });
}
