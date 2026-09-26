#!/usr/bin/env node
// Writes firebase.json for one environment: two Hosting targets (citizen,
// admin) whose /api/v1/** rewrites come from packages/config/api-routes.json,
// plus Firestore rules. Generated, not hand-kept, because Cloud Run service
// ids carry the environment suffix (submission-service-ncr-dev).
//   node infra/scripts/gen-firebase-json.mjs ncr-dev [region]
import { readFileSync, writeFileSync } from 'node:fs';

const [env, region = 'asia-south1'] = process.argv.slice(2);
if (!env) {
  console.error('usage: gen-firebase-json.mjs <environment_name> [region]');
  process.exit(1);
}
const routes = JSON.parse(readFileSync(new URL('../../packages/config/api-routes.json', import.meta.url), 'utf-8'));

const apiRewrites = Object.entries(routes.services).flatMap(([svc, cfg]) =>
  cfg.prefixes.flatMap((prefix) =>
    [prefix, `${prefix}/**`].map((source) => ({ source, run: { serviceId: `${svc}-${env}`, region } })),
  ),
);

const securityHeaders = {
  source: '**',
  headers: [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(self)' },
  ],
};
// Service worker + manifest must never be cached, or clients pin an old app.
const noCache = { source: '/@(sw.js|registerSW.js|manifest.webmanifest)', headers: [{ key: 'Cache-Control', value: 'no-cache' }] };
const immutableAssets = { source: '/assets/**', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] };

const site = (target, app) => ({
  target,
  public: `apps/${app}/dist`,
  ignore: ['firebase.json', '**/.*', '**/node_modules/**', 'mockServiceWorker.js'],
  headers: [securityHeaders, noCache, immutableAssets],
  rewrites: [...apiRewrites, { source: '**', destination: '/index.html' }],
});

const config = {
  hosting: [site('citizen', 'citizen-pwa'), site('admin', 'admin-dashboard')],
  firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
};
writeFileSync(new URL('../../firebase.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
console.log(`firebase.json written for ${env} (${apiRewrites.length} API rewrites)`);
