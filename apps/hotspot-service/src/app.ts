import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createPushVerifier, type IdTokenVerifier } from '@vayusetu/gcp-clients';
import { env } from './config/env.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import { ApiHttpError } from './lib/errors.js';
import hotspotsRoutes from './routes/hotspots.js';
import pubsubRoutes from './routes/pubsub.js';
import type { DataAdapters } from './adapters/data.js';
import type { FastPathDeps } from './domain/fastPath.js';
import { buildFastPathDeps, dataAdapters } from './wiring.js';

export interface BuildAppOptions {
  data?: DataAdapters;
  fastPathDeps?: FastPathDeps;
  pushTokenVerifier?: IdTokenVerifier;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : env.NODE_ENV === 'test' ? 'silent' : 'debug',
      transport: env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty' },
    },
    trustProxy: true,
  });
  // API responses are per-user. Without an explicit no-store, the Firebase
  // Hosting CDN caches error responses (a 404 for 10 min, keyed on the URL
  // alone -- Authorization is not in Vary) and replays them to EVERY caller:
  // on 28 Sep one citizen's "no profile yet" 404 for /users/me was served to
  // all users, and registered citizens could not send reports.
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'private, no-store');
  });

  await app.register(cors, { origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') });
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(rateLimit, {
    hook: 'preHandler',
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.authUser?.uid ?? request.ip,
    errorResponseBuilder: (_req, ctx) => new ApiHttpError('RATE_LIMITED', `Rate limit exceeded, retry in ${ctx.after}`),
  });

  app.get('/health', { config: { public: true, rateLimit: false } }, async () => ({ ok: true, service: 'hotspot-service' }));

  const data = opts.data ?? dataAdapters();
  const verifyPush = createPushVerifier({
    mode: env.PUBSUB_PUSH_AUTH,
    audience: env.PUBSUB_PUSH_AUDIENCE,
    serviceAccountEmail: env.PUBSUB_PUSH_SA_EMAIL,
    verify: opts.pushTokenVerifier,
  });
  await app.register(pubsubRoutes, { deps: opts.fastPathDeps ?? buildFastPathDeps(app.log, data), verifyPush });
  await app.register(hotspotsRoutes, { prefix: '/api/v1', data });
  return app;
}
