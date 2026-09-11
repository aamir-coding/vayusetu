import type { Jurisdiction } from '@vayusetu/shared-types';

/**
 * DB_SCHEMA.md's security-rules note, applied here at the API layer too
 * (defense in depth, not either/or -- API_CONTRACTS.md §4.2): a caller
 * with no districtCode (state_admin/super_admin) matches any district in
 * their state; a district_admin caller needs an exact district match.
 *
 * This is the same logic apps/admin-dashboard/src/mocks/handlers.ts
 * already implements for the mock backend -- kept identical on purpose
 * so swapping MSW for this real service doesn't change authorization
 * behavior out from under the frontend.
 */
export function jurisdictionContains(caller: Jurisdiction, target: Jurisdiction): boolean {
  if (caller.stateCode !== target.stateCode) return false;
  if (caller.districtCode) return caller.districtCode === target.districtCode;
  return true;
}
