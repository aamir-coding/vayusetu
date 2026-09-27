import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decodePush, NonRetryableEventError, PushAuthError } from '@vayusetu/gcp-clients';
import { handleAnalysisCompleted, type FastPathDeps } from '../domain/fastPath.js';

// API_CONTRACTS.md 4.3, exactly.
const AnalysisCompletedSchema = z.object({
  submissionId: z.string().min(1),
  h3Index: z.string().regex(/^[0-9a-f]{15}$/i),
  corridorId: z.string().min(1),
});

export default async function pubsubRoutes(
  app: FastifyInstance,
  opts: { deps: FastPathDeps; verifyPush: (authorization: string | undefined) => Promise<void> },
) {
  app.post('/pubsub/analysis-completed', { config: { public: true, rateLimit: false } }, async (request, reply) => {
    try {
      await opts.verifyPush(request.headers.authorization);
    } catch (err) {
      if (err instanceof PushAuthError) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: err.message } });
      throw err;
    }
    const decoded = decodePush(request.body, AnalysisCompletedSchema);
    if (!decoded.ok) {
      request.log.error({ reason: decoded.reason }, 'Undecodable analysis.completed -- acking to drop');
      return reply.status(204).send();
    }
    try {
      const outcome = await handleAnalysisCompleted(decoded.payload, opts.deps);
      request.log.info({ ...decoded.payload, outcome }, 'analysis.completed processed');
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof NonRetryableEventError) {
        request.log.error({ err }, 'analysis.completed cannot be processed -- acking to drop');
        return reply.status(204).send();
      }
      request.log.error({ err }, 'analysis.completed failed transiently -- nacking');
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'retry' } });
    }
  });
}
