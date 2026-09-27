import type { AnalysisResult, Jurisdiction, User } from '@vayusetu/shared-types';
import { createSignedReadUrl } from '@vayusetu/gcp-clients';
import { usersCollection } from './collections.js';
import { ApiHttpError } from './errors.js';

export const OFFICIAL_ROLES = new Set<User['role']>(['district_admin', 'state_admin', 'super_admin']);

/** Officials with no jurisdiction are only legitimate for super_admin. */
export function officialScope(user: User): Jurisdiction | 'all' | null {
  if (!OFFICIAL_ROLES.has(user.role)) return null;
  if (user.role === 'super_admin') return 'all';
  return user.jurisdiction ?? null;
}

export async function requireRegisteredUser(uid: string): Promise<User> {
  const snap = await usersCollection().doc(uid).get();
  if (!snap.exists) throw new ApiHttpError('UNAUTHORIZED', 'Register before using this endpoint');
  return snap.data()!;
}

/** district_admin+ with a usable jurisdiction (super_admin: all). */
export async function requireOfficial(uid: string): Promise<{ user: User; scope: Jurisdiction | 'all' }> {
  const user = await requireRegisteredUser(uid);
  const scope = officialScope(user);
  if (scope === null) throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Officials only (district_admin and above)');
  return { user, scope };
}

export function encodePageToken(docId: string): string {
  return Buffer.from(docId, 'utf-8').toString('base64url');
}

export function decodePageToken(token: string): string {
  const id = Buffer.from(token, 'base64url').toString('utf-8');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ApiHttpError('VALIDATION_ERROR', 'Invalid pageToken');
  return id;
}

/**
 * Pipeline B audio is stored as gs:// in a private bucket; the citizen's
 * browser can't play that. Swap in a short-lived signed HTTPS URL on read.
 * Signing failure degrades to a text-only advisory, never a failed request.
 */
export async function withPlayableAudio(
  analysis: AnalysisResult | null,
  log: { warn(obj: object, msg: string): void },
): Promise<AnalysisResult | null> {
  const url = analysis?.advisory.audioStorageUrl;
  if (!analysis || !url?.startsWith('gs://')) return analysis;
  try {
    return { ...analysis, advisory: { ...analysis.advisory, audioStorageUrl: await createSignedReadUrl(url, 3600) } };
  } catch (err) {
    log.warn({ err }, 'Could not sign advisory audio URL; returning text-only advisory');
    const { audioStorageUrl: _drop, ...advisory } = analysis.advisory;
    void _drop;
    return { ...analysis, advisory };
  }
}
