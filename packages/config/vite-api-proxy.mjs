// Vite `server.proxy` built from api-routes.json: with mocks off
// (VITE_USE_MOCKS=false), `/api/v1/alerts` etc. reach the locally running
// services exactly as Firebase Hosting rewrites route them in production.
import { readFileSync } from 'node:fs';

const routes = JSON.parse(readFileSync(new URL('./api-routes.json', import.meta.url), 'utf-8'));

export function apiProxy() {
  return Object.fromEntries(
    Object.values(routes.services).flatMap((svc) =>
      svc.prefixes.map((prefix) => [prefix, { target: `http://localhost:${svc.devPort}`, changeOrigin: true }]),
    ),
  );
}
