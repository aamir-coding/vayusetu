import { env } from './config/env.js';
import { buildApp } from './app.js';

// Audit L2: Cloud Run always sets K_SERVICE, so the safety rails below hold
// even if a deploy forgets NODE_ENV=production.
const deployed = env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE);

// Audit L3: a stray rejected promise is logged as structured JSON (Cloud
// Logging severity ERROR) and the instance keeps serving, instead of Node's
// default of crashing it and dropping every in-flight request.
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ severity: 'ERROR', message: 'unhandledRejection', error: reason instanceof Error ? reason.stack : String(reason) }));
});

async function main() {
  if (deployed && env.AUTH_MODE === 'mock') {
    console.error('Refusing to start: AUTH_MODE=mock is not allowed in production (NODE_ENV=production or running on Cloud Run).');
    process.exit(1);
  }
  if (deployed && env.PUBSUB_PUSH_AUTH === 'off') {
    console.error('Refusing to start: PUBSUB_PUSH_AUTH=off is not allowed in production (NODE_ENV=production or running on Cloud Run).');
    process.exit(1);
  }
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info({ scorer: env.HOTSPOT_SCORER, project: env.GOOGLE_CLOUD_PROJECT }, 'hotspot-service listening');
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, draining`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});
