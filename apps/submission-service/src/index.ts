import { buildApp } from './app.js';
import { env } from './config/env.js';

// Audit L2: Cloud Run always sets K_SERVICE, so the safety rails below hold
// even if a deploy forgets NODE_ENV=production.
const deployed = env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE);

// Audit L3: a stray rejected promise is logged as structured JSON (Cloud
// Logging severity ERROR) and the instance keeps serving, instead of Node's
// default of crashing it and dropping every in-flight request.
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ severity: 'ERROR', message: 'unhandledRejection', error: reason instanceof Error ? reason.stack : String(reason) }));
});

// Hard safety rail: AUTH_MODE=mock (see plugins/auth.ts) must never reach
// a real deployment. Refuse to boot rather than trust every future
// deployer to remember to unset it.
if (env.AUTH_MODE === 'mock' && deployed) {
  console.error('\u274c Refusing to start: AUTH_MODE=mock is not allowed in production (NODE_ENV=production or running on Cloud Run).');
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