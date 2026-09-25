import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import { type IdTokenVerifier, createPushAuthHook } from './plugins/pushAuth.js';
import { ApiHttpError } from './lib/errors.js';
import alertsRoutes from './routes/alerts.js';
import pubsubRoutes from './routes/pubsub.js';
import type { PipelineDeps } from './pipeline/alertPipeline.js';
import { buildPipelineDeps } from './pipeline/wiring.js';

export interface BuildAppOptions {
  /** Tests inject a fake gateway/briefing/geocoder; production builds real ones. */
  pipelineDeps?: PipelineDeps;
  pushTokenVerifier?: IdTokenVerifier;
  rateLimitMax?: number;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : env.NODE_ENV === 'test' ? 'silent' : 'debug',
      transport: env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty' },
    },
    trustProxy: true,
  });

  await app.register(cors, { origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') });
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(rateLimit, {
    hook: 'preHandler',
    max: opts.rateLimitMax ?? 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.authUser?.uid ?? request.ip,
    errorResponseBuilder: (_req, ctx) => new ApiHttpError('RATE_LIMITED', `Rate limit exceeded, retry in ${ctx.after}`),
  });

  // Not /healthz: Cloud Run's public *.run.app domain intercepts that exact
  // path at the Google Frontend layer, returning its own static 404 before
  // the request reaches this container. /health avoids the collision.
  app.get('/health', { config: { public: true, rateLimit: false } }, async () => ({ ok: true, service: 'alert-service' }));

  const deps = opts.pipelineDeps ?? buildPipelineDeps(app.log);
  const pushAuth = createPushAuthHook({
    mode: env.PUBSUB_PUSH_AUTH,
    audience: env.PUBSUB_PUSH_AUDIENCE,
    serviceAccountEmail: env.PUBSUB_PUSH_SA_EMAIL,
    verify: opts.pushTokenVerifier,
  });

  // Push routes are internal (not under /api/v1): Pub/Sub is the only caller.
  await app.register(pubsubRoutes, { deps, pushAuth });
  await app.register(alertsRoutes, { prefix: '/api/v1' });

  return app;
}
