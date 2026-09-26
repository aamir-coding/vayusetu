import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAdminAuth } from '@vayusetu/gcp-clients';
import type { Jurisdiction } from '@vayusetu/shared-types';
import { env } from '../config/env.js';
import { ApiHttpError } from '../lib/errors.js';
import { getDb } from '@vayusetu/gcp-clients';
import type { CollectionReference } from 'firebase-admin/firestore';
import type { User } from '@vayusetu/shared-types';

const usersCollection = () => getDb().collection('users') as CollectionReference<User>;

export interface AuthedUser {
  uid: string;
  claims: Record<string, unknown>;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthedUser;
  }
  interface FastifyContextConfig {
    /** Skip Firebase auth. Used by /healthz and the Pub/Sub push routes
     *  (which authenticate with Google OIDC instead -- plugins/pushAuth.ts). */
    public?: boolean;
  }
}

const MOCK_TOKEN_PREFIX = 'mock-token:';

export default fp(async function authPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config?.public) return;

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ApiHttpError('UNAUTHORIZED', 'Missing or malformed Authorization header');
    const token = header.slice('Bearer '.length);

    if (env.AUTH_MODE === 'mock') {
      // Same scheme as apps/admin-dashboard's MSW mocks (mock-deshmukh, mock-iyer).
      if (!token.startsWith(MOCK_TOKEN_PREFIX)) {
        throw new ApiHttpError('UNAUTHORIZED', `AUTH_MODE=mock expects a "${MOCK_TOKEN_PREFIX}<uid>" token`);
      }
      request.authUser = { uid: token.slice(MOCK_TOKEN_PREFIX.length), claims: {} };
      return;
    }

    try {
      const decoded = await getAdminAuth().verifyIdToken(token);
      request.authUser = { uid: decoded.uid, claims: decoded as unknown as Record<string, unknown> };
    } catch (error) {
      request.log.warn({ err: error }, 'ID token verification failed');
      throw new ApiHttpError('UNAUTHORIZED', 'Invalid or expired ID token');
    }
  });
});

export interface OfficialCaller {
  uid: string;
  role: 'district_admin' | 'state_admin' | 'super_admin';
  /** 'all' only for super_admin. */
  scope: Jurisdiction | 'all';
}

const OFFICIAL_ROLES = ['district_admin', 'state_admin', 'super_admin'] as const;
type OfficialRole = (typeof OFFICIAL_ROLES)[number];
const isOfficialRole = (r: unknown): r is OfficialRole => OFFICIAL_ROLES.includes(r as OfficialRole);

function toCaller(uid: string, role: OfficialRole, stateCode?: string, districtCode?: string): OfficialCaller {
  if (role === 'super_admin') return { uid, role, scope: 'all' };
  // A mis-provisioned official gets nothing, never "everything".
  if (!stateCode) throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Account has no jurisdiction provisioned');
  if (role === 'district_admin' && !districtCode) {
    throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'district_admin account has no districtCode provisioned');
  }
  return { uid, role, scope: role === 'district_admin' ? { stateCode, districtCode } : { stateCode } };
}

/**
 * Resolves district_admin+ identity. ARCHITECTURE_OVERVIEW.md: officials'
 * `role`, `stateCode`, `districtCode` live in Firebase custom claims, and
 * claims drive API authorization -- so claims win, with no Firestore read.
 * Falls back to users/{uid} when there are no claims (mock mode, or an
 * official provisioned before claims were set). scripts/provision-official.mjs
 * writes BOTH, so the two can't disagree.
 */
export async function requireOfficial(request: FastifyRequest): Promise<OfficialCaller> {
  const user = request.authUser;
  if (!user) throw new ApiHttpError('UNAUTHORIZED', 'Not authenticated');

  const c = user.claims;
  if (isOfficialRole(c.role)) {
    return toCaller(user.uid, c.role, c.stateCode as string | undefined, c.districtCode as string | undefined);
  }

  const snap = await usersCollection().doc(user.uid).get();
  const doc = snap.exists ? snap.data()! : undefined;
  if (!doc || !isOfficialRole(doc.role)) {
    throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'district_admin or above required');
  }
  return toCaller(user.uid, doc.role, doc.jurisdiction?.stateCode, doc.jurisdiction?.districtCode);
}

/** API_CONTRACTS.md: federation reads are state_admin+; import is super_admin
 *  only ("the single highest-blast-radius action in the system"). */
export function requireRole(caller: OfficialCaller, allowed: ReadonlyArray<OfficialCaller['role']>): void {
  if (!allowed.includes(caller.role)) {
    throw new ApiHttpError('FORBIDDEN_JURISDICTION', `${allowed.join(' or ')} required`);
  }
}
