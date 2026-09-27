import Fastify, { type FastifyInstance } from 'fastify';
import { createPushVerifier, type IdTokenVerifier } from '@vayusetu/gcp-clients';
import { env } from './config/env.js';
import type { AnalysisDeps } from './pipeline/analyze.js';
import { buildAnalysisDeps } from './pipeline/wiring.js';
import pubsubRoutes from './routes/pubsub.js';

export interface BuildAppOptions {
  deps?: AnalysisDeps;
  pushTokenVerifier?: IdTokenVerifier;
}

/** Private worker: /health + one Pub/Sub push route. No /api/v1 surface. */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : env.NODE_ENV === 'test' ? 'silent' : 'debug',
      transport: env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty' },
    },
    bodyLimit: 1_048_576,
  });

  app.get('/health', async () => ({ ok: true, service: 'analysis-service' }));

  const verifyPush = createPushVerifier({
    mode: env.PUBSUB_PUSH_AUTH,
    audience: env.PUBSUB_PUSH_AUDIENCE,
    serviceAccountEmail: env.PUBSUB_PUSH_SA_EMAIL,
    verify: opts.pushTokenVerifier,
  });
  await app.register(pubsubRoutes, { deps: opts.deps ?? buildAnalysisDeps(app.log), verifyPush });
  return app;
}
