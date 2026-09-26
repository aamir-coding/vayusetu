// Seeds the Firestore EMULATOR with the corridors + official personas the
// admin dashboard's MSW mocks use, so AUTH_MODE=mock tokens
// (mock-token:mock-deshmukh / mock-token:mock-iyer) resolve to real docs.
//   FIRESTORE_EMULATOR_HOST=localhost:8081 pnpm --filter @vayusetu/alert-service seed:dev
// Corridor data is copied from apps/admin-dashboard/src/mocks/fixtures.ts;
// the canonical corridor seed is Engineer 4's (data/seed/).
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set -- this script only seeds the emulator, never real GCP.');
  process.exit(1);
}
const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'vayusetu-ncr-dev';
initializeApp({ projectId });
const db = getFirestore();
const now = new Date().toISOString();

const corridors = [
  {
    id: 'ncr-airshed', name: 'Delhi-NCR Airshed', states: ['DL', 'HR', 'UP', 'RJ'],
    boundaryGeoJsonStorageUrl: 'gs://placeholder/corridors/ncr-airshed.geojson', population: 46_000_000,
    monitoringStationIds: ['DL-DPCC-014', 'DL-DPCC-021', 'HR-SPCB-004'], grapFrameworkActive: true,
    grapThresholds: {
      stage_1: { aqiMin: 201, aqiMax: 300 }, stage_2: { aqiMin: 301, aqiMax: 400 },
      stage_3: { aqiMin: 401, aqiMax: 450 }, stage_4: { aqiMin: 451, aqiMax: 500 },
    },
    createdAt: now,
  },
  {
    id: 'mumbai-pune-corridor', name: 'Mumbai\u2013Pune Industrial Corridor', states: ['MH'],
    boundaryGeoJsonStorageUrl: 'gs://placeholder/corridors/mumbai-pune-corridor.geojson', population: 31_000_000,
    monitoringStationIds: ['MH-MPCB-009'], grapFrameworkActive: false, createdAt: now,
  },
];

const officials = [
  { uid: 'mock-deshmukh', displayName: 'Officer Deshmukh', role: 'district_admin',
    jurisdiction: { stateCode: 'DL', districtCode: 'DL-CENTRAL' }, phoneNumber: '+919800000001' },
  { uid: 'mock-iyer', displayName: 'Ms. Iyer', role: 'state_admin', jurisdiction: { stateCode: 'DL' } },
];

const batch = db.batch();
for (const c of corridors) batch.set(db.collection('corridors').doc(c.id), c);
for (const o of officials) {
  batch.set(db.collection('users').doc(o.uid), { ...o, preferredLanguage: 'en-IN', fcmTokens: [], createdAt: now, updatedAt: now }, { merge: true });
}
await batch.commit();
console.log(`Seeded ${corridors.length} corridors + ${officials.length} officials into ${process.env.FIRESTORE_EMULATOR_HOST} (project=${projectId})`);
