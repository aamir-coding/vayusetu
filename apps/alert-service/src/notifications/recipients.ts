import type { Jurisdiction, User } from '@vayusetu/shared-types';
import { usersCollection } from '../lib/collections.js';
import { jurisdictionContains } from '../lib/jurisdiction.js';
import type { Recipient } from './types.js';

const NOTIFIABLE_ROLES = new Set<User['role']>(['district_admin', 'state_admin']);

/**
 * Officials to notify for an alert = exactly the officials allowed to open
 * it (same jurisdictionContains rule as GET /alerts/:id). So:
 *   {DL, DL-CENTRAL} alert -> DL-CENTRAL district admins + DL state admins
 *   {DL} state-level alert -> DL state admins only
 * super_admins are not paged; they have no jurisdiction to act in.
 *
 * Single equality filter on purpose: it's served by Firestore's automatic
 * single-field index, so no composite index is needed. Role/district are
 * filtered in memory (officials per state number in the tens).
 */
export async function findRecipients(target: Jurisdiction): Promise<Recipient[]> {
  const snap = await usersCollection().where('jurisdiction.stateCode', '==', target.stateCode).get();
  return snap.docs
    .map((d) => d.data())
    .filter((u) => NOTIFIABLE_ROLES.has(u.role) && u.jurisdiction && jurisdictionContains(u.jurisdiction, target))
    .map((u) => ({
      uid: u.uid,
      role: u.role,
      fcmTokens: u.fcmTokens ?? [],
      ...(u.phoneNumber ? { phoneNumber: u.phoneNumber } : {}),
      preferredLanguage: u.preferredLanguage,
    }));
}
