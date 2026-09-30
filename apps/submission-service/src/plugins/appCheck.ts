import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { getAdminAppCheck } from '@vayusetu/gcp-clients';
import { ApiHttpError } from '../lib/errors.js';

export type AppCheckMode = 'off' | 'monitor' | 'enforce';
export type AppCheckVerifier = (token: string) => Promise<unknown>;

/**
 * Citizen write routes: the ones an anonymous-auth script would hammer to
 * mint "distinct citizens" and push a cell to an alert (audit H1). Reads and
 * the officials' routes (/users/me, /resources/requests) stay unchecked, so
 * the admin dashboard never needs an App Check token.
 */
export const APP_CHECK_ROUTES = new Set([
  'POST /api/v1/users/register',
  'POST /api/v1/submissions/upload-url',
  'POST /api/v1/submissions',
  'POST /api/v1/submissions/:id/clarify',
  'POST /api/v1/submissions/:id/retry-analysis',
]);

export const APP_CHECK_HEADER = 'x-firebase-appcheck';

/**
 * Firebase App Check (audit H1). An anonymous Firebase account costs a
 * script nothing; an App Check token proves the request came from the real
 * PWA on a real browser (reCAPTCHA Enterprise attestation).
 *
 * Runs as a preHandler, after auth: an unauthenticated call is already a 401.
 */
export default fp<{ mode: AppCheckMode; verify?: AppCheckVerifier }>(async function appCheckPlugin(app: FastifyInstance, opts) {
  if (opts.mode === 'off') return;
  const verify: AppCheckVerifier = opts.verify ?? ((token) => getAdminAppCheck().verifyToken(token));

  app.addHook('preHandler', async (request) => {
    if (!APP_CHECK_ROUTES.has(`${request.method} ${request.routeOptions.url}`)) return;
    const header = request.headers[APP_CHECK_HEADER];
    const token = typeof header === 'string' ? header : undefined;
    let problem: string | undefined;
    if (!token) {
      problem = 'missing';
    } else {
      try {
        await verify(token);
      } catch {
        problem = 'invalid';
      }
    }
    if (!problem) return;
    request.log.warn({ appCheck: problem, route: request.routeOptions.url, uid: request.authUser?.uid, mode: opts.mode }, 'App Check token ' + problem);
    if (opts.mode === 'enforce') throw new ApiHttpError('UNAUTHORIZED', 'This request must come from the VayuSetu app');
  });
});
