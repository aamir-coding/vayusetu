import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decodePush, NonRetryableEventError, PushAuthError } from '@vayusetu/gcp-clients';
import { analyzeSubmission, type AnalysisDeps } from '../pipeline/analyze.js';

// API_CONTRACTS.md 4.3, exactly.
const SubmissionCreatedSchema = z.object({ submissionId: z.string().min(1) });

/**
 * submission.created push endpoint. Response code = ack protocol:
 * 204 ack (done / duplicate / permanently undeliverable), 401 bad push token,
 * 500 nack (transient: Gemini/BigQuery/Firestore hiccup -> redelivery).
 */
export default async function pubsubRoutes(
  app: FastifyInstance,
  opts: { deps: AnalysisDeps; verifyPush: (authorization: string | undefined) => Promise<void> },
) {
  app.post('/pubsub/submission-created', async (request, reply) => {
    try {
      await opts.verifyPush(request.headers.authorization);
    } catch (err) {
      if (err instanceof PushAuthError) {
        request.log.warn({ reason: err.message }, 'Rejected Pub/Sub push');
        return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: err.message } });
      }
      throw err;
    }

    const decoded = decodePush(request.body, SubmissionCreatedSchema);
    if (!decoded.ok) {
      request.log.error({ reason: decoded.reason, detail: decoded.detail }, 'Undecodable submission.created -- acking to drop');
      return reply.status(204).send();
    }
    const { submissionId } = decoded.payload;
    const log = request.log.child({ submissionId, messageId: decoded.messageId, deliveryAttempt: decoded.deliveryAttempt });
    try {
      const outcome = await analyzeSubmission(submissionId, opts.deps);
      log.info({ outcome }, 'submission.created processed');
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof NonRetryableEventError) {
        log.error({ err }, 'submission.created cannot be processed -- acking to drop');
        return reply.status(204).send();
      }
      log.error({ err }, 'submission.created failed transiently -- nacking for redelivery');
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'retry' } });
    }
  });
}
