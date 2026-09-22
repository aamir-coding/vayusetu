import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAdminAuth } from '@vayusetu/gcp-clients';
import { env } from '../config/env.js';
import { ApiHttpError } from '../lib/errors.js';

export interface AuthedUser {
  uid: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthedUser;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

const MOCK_TOKEN_PREFIX = 'mock-token:';

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiHttpError('UNAUTHORIZED', 'Missing or malformed Authorization header');
  }
  return header.slice('Bearer '.length);
}

/**
 * Auth applies to every route except ones registered with
 * `{ config: { public: true } }` (only /healthz uses this) --
 * API_CONTRACTS.md §4.2: "no unauthenticated endpoint exists in this
 * system, including citizen submission, because jurisdiction-correct
 * routing requires a resolvable identity."
 *
 * AUTH_MODE=mock exists purely so this service is testable against
 * apps/citizen-pwa's `mock-token:<uid>` scheme (see
 * apps/citizen-pwa/src/mocks/fixtures.ts#extractUid) before Firebase
 * Auth is wired end-to-end -- index.ts refuses to boot with
 * AUTH_MODE=mock in production, so this can never silently ship.
 *
 * Registered via fastify-plugin (`fp`) specifically so this hook applies
 * to every route on the app regardless of registration order -- fp()
 * breaks out of Fastify's normal encapsulation, attaching hooks to the
 * root instance instead of just routes registered after this point.
 */
export default fp(async function authPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config?.public) return;

    const token = extractBearerToken(request);

    if (env.AUTH_MODE === 'mock') {
      if (!token.startsWith(MOCK_TOKEN_PREFIX)) {
        throw new ApiHttpError('UNAUTHORIZED', `AUTH_MODE=mock expects a "${MOCK_TOKEN_PREFIX}<uid>" token`);
      }
      request.authUser = { uid: token.slice(MOCK_TOKEN_PREFIX.length) };
      return;
    }

    try {
      const decoded = await getAdminAuth().verifyIdToken(token);
      request.authUser = { uid: decoded.uid };
    } catch (error) {
      request.log.warn({ err: error }, 'ID token verification failed');
      throw new ApiHttpError('UNAUTHORIZED', 'Invalid or expired ID token');
    }
  });
});

export function requireAuthUser(request: FastifyRequest): AuthedUser {
  if (!request.authUser) {
    throw new ApiHttpError('UNAUTHORIZED', 'Not authenticated');
  }
  return request.authUser;
}
