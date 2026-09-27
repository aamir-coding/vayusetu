import { env } from './config/env.js';
import { buildApp } from './app.js';

async function main() {
  if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'mock') {
    console.error('Refusing to start: AUTH_MODE=mock is not allowed when NODE_ENV=production.');
    process.exit(1);
  }
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info({ forecaster: env.FORECASTER, corridors: env.CORRIDOR_IDS }, 'forecast-service listening');
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
