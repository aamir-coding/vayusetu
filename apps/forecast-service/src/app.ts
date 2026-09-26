import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import { ApiHttpError } from './lib/errors.js';
import forecastsRoutes from './routes/forecasts.js';

/** REST only; forecasts are produced by the 6-hourly job (src/jobs/scoreForecast.ts). */
export async function buildApp(): Promise<FastifyInstance> {
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
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.authUser?.uid ?? request.ip,
    errorResponseBuilder: (_req, ctx) => new ApiHttpError('RATE_LIMITED', `Rate limit exceeded, retry in ${ctx.after}`),
  });
  app.get('/health', { config: { public: true, rateLimit: false } }, async () => ({ ok: true, service: 'forecast-service' }));
  await app.register(forecastsRoutes, { prefix: '/api/v1' });
  return app;
}
