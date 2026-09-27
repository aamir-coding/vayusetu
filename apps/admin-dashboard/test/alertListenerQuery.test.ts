import { describe, expect, it } from 'vitest';
import { alertListenerFilters } from '../src/lib/alertListenerQuery';

describe('alertListenerFilters (must restate firestore.rules covers())', () => {
  it('district_admin: state + district', () => {
    expect(alertListenerFilters('district_admin', { stateCode: 'DL', districtCode: 'DL-CENTRAL' })).toEqual([
      { field: 'assignedJurisdiction.stateCode', value: 'DL' },
      { field: 'assignedJurisdiction.districtCode', value: 'DL-CENTRAL' },
    ]);
  });

  it('state_admin: state only', () => {
    expect(alertListenerFilters('state_admin', { stateCode: 'MH' })).toEqual([{ field: 'assignedJurisdiction.stateCode', value: 'MH' }]);
  });

  it('super_admin: unfiltered', () => {
    expect(alertListenerFilters('super_admin', { stateCode: 'DL' })).toEqual([]);
  });

  it('a district_admin without a district claim is refused, not widened to the state', () => {
    expect(() => alertListenerFilters('district_admin', { stateCode: 'DL' })).toThrow('districtCode');
  });
});
