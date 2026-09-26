import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  NonRetryableEventError,
  type PipelineDeps,
  handleForecastUpdated,
  handleHotspotUpdated,
} from '../pipeline/alertPipeline.js';

/** Pub/Sub push envelope (what Pub/Sub POSTs; message.data is base64 JSON). */
const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string().optional(),
    attributes: z.record(z.string()).optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
  deliveryAttempt: z.number().optional(),
});

// API_CONTRACTS.md §4.3 payloads, exactly.
const HotspotUpdatedSchema = z.object({
  hotspotCellId: z.string().min(1),
  corridorId: z.string().min(1),
  hotspotConfidenceScore: z.number().min(0).max(1),
});
const ForecastUpdatedSchema = z.object({
  forecastRunId: z.string().min(1),
  corridorId: z.string().min(1),
  maxHorizonAQI: z.number().min(0),
});

/**
 * Response codes ARE the ack protocol:
 *   2xx -> ack (done, or permanently undeliverable -- stop retrying)
 *   non-2xx -> nack -> Pub/Sub redelivers with backoff, then dead-letters
 * A malformed payload will never become valid, so it is ACKED with an error
 * log; nacking it would loop until the dead-letter threshold for nothing.
 */
function makeHandler<S extends z.ZodTypeAny>(
  topic: string,
  schema: S,
  run: (payload: z.infer<S>) => Promise<unknown>,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const envelope = PushEnvelopeSchema.safeParse(request.body);
    const log = request.log.child({ topic, messageId: envelope.success ? envelope.data.message.messageId : undefined });

    if (!envelope.success) {
      log.error({ issues: envelope.error.issues }, 'Malformed push envelope -- acking to drop');
      return reply.status(204).send();
    }

    let payload: z.infer<S>;
    try {
      const decoded = JSON.parse(Buffer.from(envelope.data.message.data, 'base64').toString('utf-8'));
      payload = schema.parse(decoded);
    } catch (error) {
      log.error({ err: error }, 'Payload violates API_CONTRACTS.md §4.3 -- acking to drop');
      return reply.status(204).send();
    }

    try {
      const outcome = await run(payload);
      log.info({ payload, outcome, deliveryAttempt: envelope.data.deliveryAttempt }, `${topic} processed`);
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof NonRetryableEventError) {
        log.error({ err: error, payload }, `${topic} cannot be processed -- acking to drop`);
        return reply.status(204).send();
      }
      log.error({ err: error, payload }, `${topic} failed transiently -- nacking for redelivery`);
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'retry' } });
    }
  };
}

export default async function pubsubRoutes(
  app: FastifyInstance,
  opts: { deps: PipelineDeps; pushAuth: (req: FastifyRequest) => Promise<void> },
) {
  // public: skip Firebase auth (push uses OIDC); no rate limit: Pub/Sub does
  // its own flow control, and a 429 would just be a nack.
  const config = { public: true, rateLimit: false } as const;

  app.post(
    '/pubsub/hotspot-updated',
    { config, preHandler: opts.pushAuth },
    makeHandler('hotspot.updated', HotspotUpdatedSchema, (p) => handleHotspotUpdated(p, opts.deps)),
  );
  app.post(
    '/pubsub/forecast-updated',
    { config, preHandler: opts.pushAuth },
    makeHandler('forecast.updated', ForecastUpdatedSchema, (p) => handleForecastUpdated(p, opts.deps)),
  );
}
