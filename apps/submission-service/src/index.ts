import { buildApp } from './app.js';
import { env } from './config/env.js';

// Hard safety rail: AUTH_MODE=mock (see plugins/auth.ts) must never reach
// a real deployment. Refuse to boot rather than trust every future
// deployer to remember to unset it.
if (env.AUTH_MODE === 'mock' && env.NODE_ENV === 'production') {
  console.error('\u274c Refusing to start: AUTH_MODE=mock is not allowed when NODE_ENV=production.');
  process.exit(1);
}

async function main() {
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(
    `submission-service listening on :${env.PORT} (project=${env.GOOGLE_CLOUD_PROJECT}, authMode=${env.AUTH_MODE})`,
  );
}

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});