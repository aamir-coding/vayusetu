import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import { ApiHttpError } from './lib/errors.js';
import federationRoutes, { type FederationRouteDeps } from './routes/federation.js';

export interface BuildAppOptions {
  /** Tests inject fakes; production builds real adapters (wiring.ts). */
  deps?: Omit<FederationRouteDeps, 'cfg' | 'now'>;
  now?: () => Date;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : env.NODE_ENV === 'test' ? 'silent' : 'debug',
      transport: env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty' },
    },
    trustProxy: true,
    // Imports wait on a cross-project model copy (see IMPORT_TIMEOUT_MS).
    requestTimeout: env.IMPORT_TIMEOUT_MS + 30_000,
  });

  await app.register(cors, { origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') });
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(rateLimit, {
    hook: 'preHandler',
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.authUser?.uid ?? request.ip,
    errorResponseBuilder: (_req, ctx) => new ApiHttpError('RATE_LIMITED', `Rate limit exceeded, retry in ${ctx.after}`),
  });

  app.get('/healthz', { config: { public: true, rateLimit: false } }, async () => ({ ok: true, service: 'federation-service' }));

  const deps = opts.deps ?? (await import('./wiring.js')).buildProductionAdapters();
  await app.register(federationRoutes, {
    prefix: '/api/v1',
    deps: {
      ...deps,
      cfg: {
        stateCode: env.FEDERATION_STATE_CODE,
        featureSchemaVersions: env.FEATURE_SCHEMA_VERSIONS,
        lookbackWeeks: env.SUMMARY_LOOKBACK_WEEKS,
        importTimeoutMs: env.IMPORT_TIMEOUT_MS,
      },
      now: opts.now ?? (() => new Date()),
    },
  });
  return app;
}
