import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';

// Runs against the Firestore EMULATOR (`pnpm test` wraps it in
// `firebase emulators:exec`). These are the actual rules deployed.
let env: RulesTestEnvironment;

const DL_CENTRAL = { stateCode: 'DL', districtCode: 'DL-CENTRAL' };
const DL_EAST = { stateCode: 'DL', districtCode: 'DL-EAST' };

const as = {
  anon: () => env.unauthenticatedContext().firestore(),
  rina: () => env.authenticatedContext('rina', { role: 'citizen' }).firestore(),
  other: () => env.authenticatedContext('other', { role: 'citizen' }).firestore(),
  deshmukh: () => env.authenticatedContext('deshmukh', { role: 'district_admin', ...DL_CENTRAL }).firestore(),
  east: () => env.authenticatedContext('east', { role: 'district_admin', ...DL_EAST }).firestore(),
  iyer: () => env.authenticatedContext('iyer', { role: 'state_admin', stateCode: 'DL' }).firestore(),
  patil: () => env.authenticatedContext('patil', { role: 'state_admin', stateCode: 'MH' }).firestore(),
  root: () => env.authenticatedContext('root', { role: 'super_admin' }).firestore(),
  // A citizen who forged a role claim can't exist (claims are server-set), but a
  // district_admin with NO district claim must not see every district.
  noDistrict: () => env.authenticatedContext('nd', { role: 'district_admin', stateCode: 'DL' }).firestore(),
};

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'vayusetu-rules-test',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf-8') },
  });
});
afterAll(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/rina'), { uid: 'rina', role: 'citizen' });
    await setDoc(doc(db, 'submissions/s1'), { id: 's1', userId: 'rina', jurisdiction: DL_CENTRAL });
    await setDoc(doc(db, 'analysisResults/s1'), { submissionId: 's1', sourceClassification: 'vehicular_smog' });
    await setDoc(doc(db, 'alerts/a-central'), { id: 'a-central', assignedJurisdiction: DL_CENTRAL, status: 'new' });
    await setDoc(doc(db, 'alerts/a-state'), { id: 'a-state', assignedJurisdiction: { stateCode: 'DL' }, status: 'new' });
    await setDoc(doc(db, 'alerts/a-mh'), { id: 'a-mh', assignedJurisdiction: { stateCode: 'MH', districtCode: 'MH-PUNE' }, status: 'new' });
    await setDoc(doc(db, 'resourceRequests/r1'), { id: 'r1', jurisdiction: DL_EAST, status: 'open' });
    await setDoc(doc(db, 'hotspots/h1'), { id: 'h1', corridorId: 'ncr-airshed' });
    await setDoc(doc(db, 'corridors/ncr-airshed'), { id: 'ncr-airshed' });
    await setDoc(doc(db, 'federationExchange/DL'), { activeModels: {} });
    await setDoc(doc(db, 'secretStuff/x'), { a: 1 });
  });
});

describe('citizens', () => {
  it('read their own profile, report and analysis -- nobody else\'s', async () => {
    await assertSucceeds(getDoc(doc(as.rina(), 'users/rina')));
    await assertSucceeds(getDoc(doc(as.rina(), 'submissions/s1')));
    await assertSucceeds(getDoc(doc(as.rina(), 'analysisResults/s1')));
    await assertFails(getDoc(doc(as.other(), 'users/rina')));
    await assertFails(getDoc(doc(as.other(), 'submissions/s1')));
    await assertFails(getDoc(doc(as.other(), 'analysisResults/s1')));
  });

  it('cannot write anything (all writes go through the API)', async () => {
    await assertFails(setDoc(doc(as.rina(), 'users/rina'), { role: 'super_admin' }));
    await assertFails(updateDoc(doc(as.rina(), 'submissions/s1'), { status: 'analyzed' }));
    await assertFails(setDoc(doc(as.rina(), 'analysisResults/s1'), { sourceClassification: 'no_visible_pollution' }));
  });

  it('never see alerts or resource requests', async () => {
    await assertFails(getDoc(doc(as.rina(), 'alerts/a-central')));
    await assertFails(getDoc(doc(as.rina(), 'resourceRequests/r1')));
  });
});

describe('officials -- jurisdiction', () => {
  it('district admin: own district only (not state-level, not other districts)', async () => {
    await assertSucceeds(getDoc(doc(as.deshmukh(), 'alerts/a-central')));
    await assertFails(getDoc(doc(as.deshmukh(), 'alerts/a-state')));
    await assertFails(getDoc(doc(as.deshmukh(), 'alerts/a-mh')));
    await assertFails(getDoc(doc(as.deshmukh(), 'resourceRequests/r1')));
    await assertSucceeds(getDoc(doc(as.east(), 'resourceRequests/r1')));
    await assertSucceeds(getDoc(doc(as.deshmukh(), 'submissions/s1')));
    await assertSucceeds(getDoc(doc(as.deshmukh(), 'analysisResults/s1')));
    await assertFails(getDoc(doc(as.east(), 'submissions/s1')));
  });

  it('the dashboard listener query is allowed only when constrained to the jurisdiction', async () => {
    const own = query(collection(as.deshmukh(), 'alerts'),
      where('assignedJurisdiction.stateCode', '==', 'DL'), where('assignedJurisdiction.districtCode', '==', 'DL-CENTRAL'));
    await assertSucceeds(getDocs(own));
    await assertFails(getDocs(collection(as.deshmukh(), 'alerts'))); // unconstrained: denied
  });

  it('state admin: the whole state, nothing outside it', async () => {
    await assertSucceeds(getDoc(doc(as.iyer(), 'alerts/a-central')));
    await assertSucceeds(getDoc(doc(as.iyer(), 'alerts/a-state')));
    await assertSucceeds(getDoc(doc(as.iyer(), 'resourceRequests/r1')));
    await assertFails(getDoc(doc(as.iyer(), 'alerts/a-mh')));
    await assertFails(getDoc(doc(as.patil(), 'alerts/a-central')));
  });

  it('super admin sees all; a district admin missing its district claim sees no district', async () => {
    await assertSucceeds(getDoc(doc(as.root(), 'alerts/a-mh')));
    await assertFails(getDoc(doc(as.noDistrict(), 'alerts/a-central')));
  });

  it('officials cannot change alert status directly (audit trail is API-only)', async () => {
    await assertFails(updateDoc(doc(as.deshmukh(), 'alerts/a-central'), { status: 'resolved' }));
  });
});

describe('shared data', () => {
  it('signed-in users read hotspots/corridors; anonymous-to-Firebase callers read nothing', async () => {
    await assertSucceeds(getDoc(doc(as.rina(), 'hotspots/h1')));
    await assertSucceeds(getDoc(doc(as.rina(), 'corridors/ncr-airshed')));
    await assertFails(getDoc(doc(as.anon(), 'hotspots/h1')));
    await assertFails(setDoc(doc(as.root(), 'hotspots/h1'), { hotspotConfidenceScore: 1 }));
  });

  it('federation mirror: state_admin and above only', async () => {
    await assertSucceeds(getDoc(doc(as.iyer(), 'federationExchange/DL')));
    await assertSucceeds(getDoc(doc(as.root(), 'federationExchange/DL')));
    await assertFails(getDoc(doc(as.deshmukh(), 'federationExchange/DL')));
    await assertFails(getDoc(doc(as.rina(), 'federationExchange/DL')));
  });

  it('unknown collections are closed to everyone', async () => {
    await assertFails(getDoc(doc(as.root(), 'secretStuff/x')));
  });
});
