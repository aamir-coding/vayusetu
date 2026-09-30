import { describe, expect, it } from 'vitest';
import { jurisdictionFromClaims, scopeLabel } from '../src/lib/officialSession';

describe('jurisdictionFromClaims', () => {
  it('accepts a super_admin with no stateCode claim (national scope)', () => {
    // Regression (30 Sep): the dashboard required stateCode for every role, so
    // super_admin@ signed in to Firebase and then sat on the login page.
    expect(jurisdictionFromClaims({ role: 'super_admin' })).toEqual({ role: 'super_admin', jurisdiction: { stateCode: '' } });
  });
  it('state and district admins need their scope claims', () => {
    expect(jurisdictionFromClaims({ role: 'state_admin', stateCode: 'DL' })).toEqual({ role: 'state_admin', jurisdiction: { stateCode: 'DL' } });
    expect(jurisdictionFromClaims({ role: 'state_admin' })).toBeNull();
    expect(jurisdictionFromClaims({ role: 'district_admin', stateCode: 'DL' })).toBeNull();
    expect(jurisdictionFromClaims({ role: 'district_admin', stateCode: 'DL', districtCode: 'DL-CENTRAL' })?.jurisdiction.districtCode).toBe('DL-CENTRAL');
  });
  it('no claims, or a non-official role, is no session', () => {
    expect(jurisdictionFromClaims({})).toBeNull();
    expect(jurisdictionFromClaims({ role: 'citizen', stateCode: 'DL' })).toBeNull();
  });
  it('labels scope as district, then state, then national', () => {
    expect(scopeLabel({ stateCode: 'DL', districtCode: 'DL-CENTRAL' })).toBe('DL-CENTRAL');
    expect(scopeLabel({ stateCode: 'MH' })).toBe('MH');
    expect(scopeLabel({ stateCode: '' })).toBe('India');
  });
});
