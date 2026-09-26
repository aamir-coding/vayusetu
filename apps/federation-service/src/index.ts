import { env } from './config/env.js';
import { buildApp } from './app.js';

async function main() {
  if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'mock') {
    console.error('Refusing to start: AUTH_MODE=mock is not allowed when NODE_ENV=production.');
    process.exit(1);
  }
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info({ state: env.FEDERATION_STATE_CODE, exchange: env.EXCHANGE_PROJECT_ID }, 'federation-service listening');
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});
