import type { Jurisdiction } from '@vayusetu/shared-types';

export interface ListenerFilter {
  field: 'assignedJurisdiction.stateCode' | 'assignedJurisdiction.districtCode';
  value: string;
}

/**
 * The equality filters for the alert-queue listener. Firestore rules are not
 * filters: a query is only allowed if every doc it COULD return passes
 * `covers(assignedJurisdiction)`, so the query must restate the official's
 * scope exactly -- state for state_admin, state + district for district_admin,
 * nothing for super_admin. Each (field, createdAt DESC) pair is served by the
 * merge indexes in firestore.tf.
 */
export function alertListenerFilters(role: string, j: Jurisdiction): ListenerFilter[] {
  if (role === 'super_admin') return [];
  const filters: ListenerFilter[] = [{ field: 'assignedJurisdiction.stateCode', value: j.stateCode }];
  if (role !== 'state_admin') {
    if (!j.districtCode) throw new Error('district_admin session without a districtCode claim');
    filters.push({ field: 'assignedJurisdiction.districtCode', value: j.districtCode });
  }
  return filters;
}
