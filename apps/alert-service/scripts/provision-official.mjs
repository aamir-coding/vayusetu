// Provisions a district_admin / state_admin / super_admin "out-of-band"
// (API_CONTRACTS.md: officials are never self-registered). Writes BOTH the
// Firebase custom claims (what API authz + Firestore rules read, per
// ARCHITECTURE_OVERVIEW.md) AND users/{uid} (what notification routing
// reads) in one step, so the two can never disagree.
//
//   node scripts/provision-official.mjs --email officer@example.gov.in \
//     --role district_admin --state DL --district DL-CENTRAL \
//     [--phone +9198xxxxxxxx] [--name "Officer Deshmukh"] --yes
//
// Works against the Auth emulator (FIREBASE_AUTH_EMULATOR_HOST) or a real
// project (ADC with Firebase Auth admin rights). The officer must sign out
// and back in (or force-refresh their ID token) before new claims apply.
import { parseArgs } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const { values: v } = parseArgs({
  options: {
    uid: { type: 'string' }, email: { type: 'string' },
    role: { type: 'string' }, state: { type: 'string' }, district: { type: 'string' },
    phone: { type: 'string' }, name: { type: 'string' }, yes: { type: 'boolean', default: false },
  },
});

const ROLES = ['district_admin', 'state_admin', 'super_admin'];
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!v.uid && !v.email) fail('Pass --uid or --email');
if (!ROLES.includes(v.role)) fail(`--role must be one of ${ROLES.join(', ')}`);
if (v.role !== 'super_admin' && !v.state) fail('--state is required for district_admin/state_admin');
if (v.role === 'district_admin' && !v.district) fail('--district is required for district_admin');
if (v.role !== 'district_admin' && v.district) fail('--district only applies to district_admin');
if (v.phone && !/^\+91\d{10}$/.test(v.phone)) fail('--phone must be E.164 Indian format, e.g. +919812345678');

const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'vayusetu-ncr-dev';
initializeApp({ projectId });
const auth = getAuth();
const user = v.uid ? await auth.getUser(v.uid) : await auth.getUserByEmail(v.email);

const claims = { role: v.role, ...(v.state ? { stateCode: v.state } : {}), ...(v.district ? { districtCode: v.district } : {}) };
const target = process.env.FIREBASE_AUTH_EMULATOR_HOST ? `Auth EMULATOR (${projectId})` : `REAL project ${projectId}`;
console.log(`About to provision ${user.uid} (${user.email ?? 'no email'}) on ${target}:`, claims);
if (!v.yes) fail('Dry run only. Re-run with --yes to apply.');

// Preserve any unrelated existing claims.
await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), ...claims });

const now = new Date().toISOString();
const ref = getFirestore().collection('users').doc(user.uid);
const existing = (await ref.get()).data();
await ref.set(
  {
    uid: user.uid,
    ...(user.email ? { email: user.email } : {}),
    displayName: v.name ?? existing?.displayName ?? user.displayName ?? user.email ?? user.uid,
    role: v.role,
    preferredLanguage: existing?.preferredLanguage ?? 'en-IN',
    ...(v.state ? { jurisdiction: { stateCode: v.state, ...(v.district ? { districtCode: v.district } : {}) } } : {}),
    ...(v.phone ? { phoneNumber: v.phone } : {}),
    fcmTokens: existing?.fcmTokens ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  },
  { merge: true },
);
console.log('Done. Claims + users doc written. The officer must re-sign-in for the new claims to take effect.');
