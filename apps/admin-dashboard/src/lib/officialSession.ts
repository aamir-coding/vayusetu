import type { Jurisdiction, UserRole } from '@vayusetu/shared-types';

export type OfficialRole = Extract<UserRole, 'district_admin' | 'state_admin' | 'super_admin'>;

export interface OfficialClaims {
  role?: string;
  stateCode?: string;
  districtCode?: string;
}

/**
 * Which custom claims make a usable official session. A super_admin has
 * national scope and NO stateCode claim by design; requiring one for every
 * role left the super admin stuck on the login page after a successful
 * Firebase sign-in (30 Sep). Accounts whose claims don't fit their role
 * (e.g. not yet provisioned) still get no session -- never a guessed role.
 */
export function jurisdictionFromClaims(claims: OfficialClaims): { role: OfficialRole; jurisdiction: Jurisdiction } | null {
  switch (claims.role) {
    case 'super_admin':
      return { role: 'super_admin', jurisdiction: { stateCode: claims.stateCode ?? '' } };
    case 'state_admin':
      return claims.stateCode ? { role: 'state_admin', jurisdiction: { stateCode: claims.stateCode } } : null;
    case 'district_admin':
      return claims.stateCode && claims.districtCode
        ? { role: 'district_admin', jurisdiction: { stateCode: claims.stateCode, districtCode: claims.districtCode } }
        : null;
    default:
      return null;
  }
}

/** Short scope label for the header: district, else state, else national. */
export function scopeLabel(j: Jurisdiction): string {
  return j.districtCode || j.stateCode || 'India';
}
