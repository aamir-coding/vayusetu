import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import usersRoutes from './routes/users.js';
import submissionsRoutes from './routes/submissions.js';

/**
 * Split out from index.ts so tests can build a fully-wired app and drive
 * it with Fastify's `.inject()` -- no real network port, no emulator
 * process to manage, no timing races. index.ts's only job is calling this
 * and then `.listen()`.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : env.NODE_ENV === 'test' ? 'silent' : 'debug',
      transport: env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty' },
    },
  });

  await app.register(cors, { origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(errorHandlerPlugin);

  // Registered before route registration for readability; auth.ts uses
  // fastify-plugin (fp), so it applies globally regardless of order.
  await app.register(authPlugin);

  app.get('/healthz', { config: { public: true } }, async () => ({ ok: true, service: 'submission-service' }));

  await app.register(usersRoutes, { prefix: '/api/v1' });
  await app.register(submissionsRoutes, { prefix: '/api/v1' });

  return app;
}