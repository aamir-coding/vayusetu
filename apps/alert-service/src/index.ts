import { env } from './config/env.js';
import { buildApp } from './app.js';

async function main() {
  // Safety rails: either of these in production would let anyone act as any
  // official, or forge hotspot events that page officials by SMS.
  if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'mock') {
    console.error('Refusing to start: AUTH_MODE=mock is not allowed when NODE_ENV=production.');
    process.exit(1);
  }
  if (env.NODE_ENV === 'production' && env.PUBSUB_PUSH_AUTH === 'off') {
    console.error('Refusing to start: PUBSUB_PUSH_AUTH=off is not allowed when NODE_ENV=production.');
    process.exit(1);
  }

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(
    { authMode: env.AUTH_MODE, pushAuth: env.PUBSUB_PUSH_AUTH, project: env.GOOGLE_CLOUD_PROJECT },
    'alert-service listening',
  );

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
