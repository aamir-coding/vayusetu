import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import { ApiHttpError } from './lib/errors.js';
import authPlugin from './plugins/auth.js';
import usersRoutes from './routes/users.js';
import submissionsRoutes from './routes/submissions.js';
import uploadsRoutes from './routes/uploads.js';

export interface BuildAppOptions {
  /** Overrides RATE_LIMIT_MAX_PER_MINUTE -- lets tests exercise 429 without 60+ requests. */
  rateLimitMax?: number;
}

/**
 * Split out from index.ts so tests can build a fully-wired app and drive
 * it with Fastify's `.inject()`. index.ts's only job is calling this and
 * then `.listen()`.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : env.NODE_ENV === 'test' ? 'silent' : 'debug',
      transport: env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty' },
    },
    // Cloud Run sits behind Google's front end; without this, request.ip is
    // the proxy's address, not the client's.
    trustProxy: true,
  });

  await app.register(cors, { origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') });
  await app.register(errorHandlerPlugin);

  // auth.ts uses fastify-plugin (fp), so its onRequest hook applies globally.
  await app.register(authPlugin);

  // preHandler runs AFTER auth's onRequest hook, so the limit can key on the
  // verified uid. Week 1 keyed on IP at onRequest -- behind carrier CGNAT
  // that throttles unrelated citizens together.
  await app.register(rateLimit, {
    hook: 'preHandler',
    max: opts.rateLimitMax ?? env.RATE_LIMIT_MAX_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.authUser?.uid ?? request.ip,
    // The plugin THROWS this return value into setErrorHandler (verified in
    // @fastify/rate-limit@10 source), so return an ApiHttpError, not a body.
    errorResponseBuilder: (_request, context) =>
      new ApiHttpError('RATE_LIMITED', `Rate limit exceeded, retry in ${context.after}`),
  });

  // Not /healthz: Cloud Run's public *.run.app domain intercepts that exact
  // path at the Google Frontend layer and returns its own static 404 before
  // the request ever reaches this container (confirmed empirically -- every
  // sibling path reaches the app fine, only the literal "/healthz" string
  // doesn't). /health avoids the collision.
  app.get('/health', { config: { public: true, rateLimit: false } }, async () => ({
    ok: true,
    service: 'submission-service',
  }));

  await app.register(usersRoutes, { prefix: '/api/v1' });
  await app.register(uploadsRoutes, { prefix: '/api/v1' });
  await app.register(submissionsRoutes, { prefix: '/api/v1' });

  return app;
}
