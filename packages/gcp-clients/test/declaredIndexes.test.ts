import { describe, expect, it } from 'vitest';
import { FakeFirestore, missingIndex, terraformIndexes } from '../src/testing/fakeFirestore.js';

const indexes = terraformIndexes();
const has = (collection: string, ...fields: string[]) =>
  indexes.some((ix) => ix.collection === collection && ix.fields.map((f) => `${f.path} ${f.dir}`).join(', ') === fields.join(', '));

describe('terraformIndexes', () => {
  it('parses literal and for_each (local.merge_indexes) declarations across the module', () => {
    expect(has('submissions', 'userId asc', 'uploadedAt desc')).toBe(true); // literal, firestore.tf
    expect(has('submissions', 'h3Index asc', 'uploadedAt desc')).toBe(true); // merge_indexes
    expect(has('hotspots', 'h3Index asc', 'timestampHour desc')).toBe(true); // hotspot.tf
    expect(has('forecasts', 'corridorId asc', 'forecastRunTimestamp desc')).toBe(true); // forecast.tf
    expect(indexes.length).toBeGreaterThanOrEqual(18); // the 18 live in vayusetu-ncr-dev on 28 Sep
  });
});

describe('missingIndex', () => {
  const shape = (filters: Array<[string, string]>, order?: [string, 'asc' | 'desc']) => ({
    filters: filters.map(([field, op]) => ({ field, op })),
    ...(order ? { order: { field: order[0], dir: order[1] } } : {}),
  });

  it('a range with no orderBy sorts ASCENDING: the 28 Sep fast-path bug', () => {
    expect(missingIndex('submissions', shape([['h3Index', '=='], ['uploadedAt', '>=']]), indexes)).toBe(
      'submissions (h3Index ASC, uploadedAt ASC)',
    );
    expect(missingIndex('submissions', shape([['h3Index', '=='], ['uploadedAt', '>=']], ['uploadedAt', 'desc']), indexes)).toBeUndefined();
  });

  it('equality-only and single-field queries need no composite', () => {
    expect(missingIndex('alerts', shape([['h3Index', '=='], ['type', '==']]), indexes)).toBeUndefined();
    expect(missingIndex('hotspots', shape([['timestampHour', '>='], ['timestampHour', '<']]), indexes)).toBeUndefined();
  });

  it('indexes sharing a sort suffix merge; an unindexed equality field does not', () => {
    const q = shape([['assignedJurisdiction.stateCode', '=='], ['assignedJurisdiction.districtCode', '=='], ['status', '==']], ['createdAt', 'desc']);
    expect(missingIndex('alerts', q, indexes)).toBeUndefined();
    expect(missingIndex('alerts', shape([['h3Index', '==']], ['createdAt', 'desc']), indexes)).toMatch(/h3Index ASC, createdAt DESC/);
  });

  it('two inequality fields always need an index nobody declared', () => {
    expect(missingIndex('submissions', shape([['uploadedAt', '>='], ['severity', '>']]), indexes)).toMatch(/inequality/);
  });
});

describe('FakeFirestore enforcement', () => {
  it('throws code 9 like the real project, unless opted out', async () => {
    const query = (db: FakeFirestore) => db.collection('submissions').where('h3Index', '==', 'x').where('uploadedAt', '>=', '2026').get();
    await expect(query(new FakeFirestore())).rejects.toMatchObject({ code: 9, message: expect.stringMatching(/requires an index/) });
    await expect(query(new FakeFirestore({ indexes: false }))).resolves.toMatchObject({ size: 0 });
  });

  it('subcollections are checked by collection id', async () => {
    const db = new FakeFirestore();
    const q = db.collection('federationExchange/NCR/sharedModels').where('state', '==', 'x').orderBy('createdAt', 'desc');
    await expect(q.get()).rejects.toMatchObject({ code: 9, message: expect.stringMatching(/sharedModels \(state ASC, createdAt DESC\)/) });
  });
});
