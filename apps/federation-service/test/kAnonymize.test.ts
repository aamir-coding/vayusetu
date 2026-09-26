import { describe, expect, it } from 'vitest';
import { cellToChildren, getResolution, latLngToCell } from 'h3-js';
import { type Contribution, type HotspotObservation, kAnonymizeWeek, lastCompleteWeekIst, reportBucket } from '../src/lib/kAnonymize.js';

const PARENT = latLngToCell(28.6329, 77.2195, 6); // central Delhi, res 6
const KIDS = cellToChildren(PARENT, 8); // its res-8 children (the internal grid)
const OTHER_PARENT = latLngToCell(28.4595, 77.0266, 6); // Gurugram
const base = { weekStartDate: '2026-09-14', modelVersion: 'hs-v2', sharedAt: '2026-09-22T01:00:00.000Z' };

const obs = (cells: string[], score: number): HotspotObservation[] => cells.map((h3Index) => ({ h3Index, hotspotConfidenceScore: score }));
function people(n: number, reportsEach = 1, state = 'DL', cells = KIDS): Contribution[] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: reportsEach }, (_, r) => ({ h3Index: cells[(i + r) % cells.length]!, userId: `user-${i}`, stateCode: state })),
  ).flat();
}

describe('kAnonymizeWeek', () => {
  it('publishes a cell with >= k distinct contributors: generalized to res 6, exact DDL columns only', () => {
    const { rows } = kAnonymizeWeek({ ...base, observations: obs(KIDS.slice(0, 3), 0.8), contributions: people(12) });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['avg_hotspot_confidence', 'h3_index_generalized', 'model_version', 'shared_at', 'source_state_code', 'underlying_report_count_bucket', 'week_start_date'],
    );
    expect(rows[0]).toMatchObject({ h3_index_generalized: PARENT, source_state_code: 'DL', underlying_report_count_bucket: '10-50' });
    expect(getResolution(rows[0]!.h3_index_generalized)).toBe(6);
  });

  it('PRIVACY: one citizen filing 15 reports is NOT published -- the report floor alone is not k-anonymity', () => {
    const { rows, suppressed } = kAnonymizeWeek({ ...base, observations: obs(KIDS, 0.9), contributions: people(1, 15) });
    expect(rows).toHaveLength(0);
    expect(suppressed.belowContributorFloor).toBe(1);
  });

  it('suppresses k-1 contributors, and >= k contributors with too few reports', () => {
    expect(kAnonymizeWeek({ ...base, observations: obs(KIDS, 0.9), contributions: people(9, 3) }).rows).toHaveLength(0);
    const r = kAnonymizeWeek({ ...base, observations: obs(KIDS, 0.9), contributions: people(10), options: { minReports: 20 } });
    expect(r.rows).toHaveLength(0);
    expect(r.suppressed.belowReportFloor).toBe(1);
  });

  it('never leaks identities, res-8 cells or exact counts in the output', () => {
    const { rows } = kAnonymizeWeek({ ...base, observations: obs(KIDS, 0.73), contributions: people(37) });
    const out = JSON.stringify(rows);
    expect(out).not.toContain('user-');
    for (const kid of KIDS) expect(out).not.toContain(kid);
    expect(out).not.toMatch(/\b37\b/); // exact report count
    expect(rows[0]!.underlying_report_count_bucket).toBe('10-50');
  });

  it('buckets report counts per the DDL and never below 10', () => {
    expect([9, 10, 49, 50, 199, 200, 5000].map((n) => reportBucket(n, 10))).toEqual([null, '10-50', '10-50', '50-200', '50-200', '200+', '200+']);
    expect(reportBucket(9, 1)).toBeNull(); // a lower configured floor can't go under the DDL's
  });

  it('averages confidence across all child cells and hours, rounded to 2 dp', () => {
    const observations = [...obs(KIDS.slice(0, 2), 0.9), ...obs(KIDS.slice(2, 3), 0.61)];
    const { rows } = kAnonymizeWeek({ ...base, observations, contributions: people(10) });
    expect(rows[0]!.avg_hotspot_confidence).toBe(0.8); // (0.9+0.9+0.61)/3 = 0.8033
  });

  it('labels a border cell with its majority state; ties resolve deterministically', () => {
    const mixed = [...people(7, 1, 'HR'), ...people(5, 1, 'DL').map((c) => ({ ...c, userId: `dl-${c.userId}` }))];
    expect(kAnonymizeWeek({ ...base, observations: obs(KIDS, 0.8), contributions: mixed }).rows[0]!.source_state_code).toBe('HR');
    const tie = [...people(6, 1, 'UP'), ...people(6, 1, 'HR').map((c) => ({ ...c, userId: `hr-${c.userId}` }))];
    expect(kAnonymizeWeek({ ...base, observations: obs(KIDS, 0.8), contributions: tie }).rows[0]!.source_state_code).toBe('HR');
  });

  it('needs both a score and contributors; ignores invalid or already-coarse cells', () => {
    const r = kAnonymizeWeek({
      ...base,
      observations: [...obs(KIDS, 0.8), { h3Index: 'not-a-cell', hotspotConfidenceScore: 0.9 }, { h3Index: PARENT, hotspotConfidenceScore: 0.9 }],
      contributions: [...people(12), ...people(12, 1, 'HR', cellToChildren(OTHER_PARENT, 8))],
    });
    expect(r.rows.map((x) => x.h3_index_generalized)).toEqual([PARENT]); // Gurugram had reports but no score
    const noPeople = kAnonymizeWeek({ ...base, observations: obs(KIDS, 0.8), contributions: [] });
    expect(noPeople.suppressed.noContributions).toBe(1);
  });

  it('refuses k < 2', () => {
    expect(() => kAnonymizeWeek({ ...base, observations: [], contributions: [], options: { minContributors: 1 } })).toThrow();
  });
});

describe('lastCompleteWeekIst', () => {
  it('returns the previous Mon-Sun week in IST as UTC bounds', () => {
    // Wed 23 Sep 2026, 15:30 IST
    expect(lastCompleteWeekIst(new Date('2026-09-23T10:00:00Z'))).toEqual({
      weekStartDate: '2026-09-14',
      startUtc: new Date('2026-09-13T18:30:00Z'),
      endUtc: new Date('2026-09-20T18:30:00Z'),
    });
  });

  it('rolls over at IST midnight Monday, not UTC midnight', () => {
    expect(lastCompleteWeekIst(new Date('2026-09-20T18:20:00Z')).weekStartDate).toBe('2026-09-07'); // Sun 23:50 IST
    expect(lastCompleteWeekIst(new Date('2026-09-20T18:40:00Z')).weekStartDate).toBe('2026-09-14'); // Mon 00:10 IST
  });
});
