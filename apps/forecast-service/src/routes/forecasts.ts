import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '@vayusetu/gcp-clients';
import type { ForecastRun } from '@vayusetu/shared-types';
import { requireAuthUser } from '../plugins/auth.js';
import { ApiHttpError } from '../lib/errors.js';

const CorridorParam = z.object({ corridorId: z.string().regex(/^[a-z0-9-]{1,64}$/) });
const HistoryQuery = z.object({ range: z.enum(['7d', '30d', '90d']).default('7d') });
const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

/** Firestore docs carry an audit field (contextSources) that is not part of ForecastRun. */
function toContract(d: Record<string, unknown>): ForecastRun {
  const { contextSources: _c, ...run } = d;
  void _c;
  return run as unknown as ForecastRun;
}

async function requireCorridor(corridorId: string): Promise<void> {
  const snap = await getDb().collection('corridors').doc(corridorId).get();
  if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'Unknown corridor');
}

export default async function forecastsRoutes(app: FastifyInstance) {
  // GET /forecasts/:corridorId/latest -- API_CONTRACTS.md 4.2
  app.get('/forecasts/:corridorId/latest', async (request, reply) => {
    requireAuthUser(request);
    const { corridorId } = CorridorParam.parse(request.params);
    await requireCorridor(corridorId);
    const snap = await getDb().collection('forecasts').where('corridorId', '==', corridorId).orderBy('forecastRunTimestamp', 'desc').limit(1).get();
    const doc = snap.docs[0];
    if (!doc) throw new ApiHttpError('NOT_FOUND', 'No forecast has run for this corridor yet');
    reply.send(toContract(doc.data()));
  });

  // GET /forecasts/:corridorId/history?range=7d|30d|90d
  app.get('/forecasts/:corridorId/history', async (request, reply) => {
    requireAuthUser(request);
    const { corridorId } = CorridorParam.parse(request.params);
    const { range } = HistoryQuery.parse(request.query);
    await requireCorridor(corridorId);
    const since = new Date(Date.now() - RANGE_DAYS[range] * 86_400_000).toISOString();
    const snap = await getDb()
      .collection('forecasts')
      .where('corridorId', '==', corridorId)
      .where('forecastRunTimestamp', '>=', since)
      .orderBy('forecastRunTimestamp', 'desc')
      .limit(400)
      .get();
    reply.send({ corridorId, runs: snap.docs.map((d) => toContract(d.data())) });
  });
}
