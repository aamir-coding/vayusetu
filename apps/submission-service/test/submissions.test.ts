import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeFirestore } from './fakeFirestore.js';

// AUTH_MODE=mock means the auth plugin never calls getAdminAuth() -- the
// throw below is a canary that fails loudly if some code path starts
// calling it unexpectedly instead of silently no-op'ing.
const fakeDb = new FakeFirestore();
const published: Array<{ topic: string; payload: unknown }> = [];

vi.mock('@vayusetu/gcp-clients', () => ({
  getDb: () => fakeDb,
  getAdminAuth: () => {
    throw new Error('getAdminAuth() should never be called while AUTH_MODE=mock');
  },
  publishEvent: async (topic: string, payload: unknown) => {
    published.push({ topic, payload });
    return 'fake-message-id';
  },
}));

// config/env.ts reads process.env at module-evaluation time, so these
// must be set before anything that transitively imports it is loaded --
// hence the dynamic import() below rather than a static one.
process.env.AUTH_MODE = 'mock';
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLOUD_PROJECT = 'vayusetu-test';
process.env.DEFAULT_STATE_CODE = 'DL';
process.env.DEFAULT_DISTRICT_CODE = 'DL-CENTRAL';
process.env.CORS_ORIGIN = '*';

const { buildApp } = await import('../src/app.js');

function authHeader(uid: string) {
  return { authorization: `Bearer mock-token:${uid}` };
}

const now = () => new Date().toISOString();

describe('submission-service', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    published.length = 0;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /healthz', () => {
    it('responds 200 with no auth header at all', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, service: 'submission-service' });
    });
  });

  describe('auth', () => {
    it('rejects a protected route with no Authorization header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/users/me' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });

    it('rejects a header that is not "Bearer <token>"', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a Bearer token that is not the mock-token:<uid> shape (AUTH_MODE=mock)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: 'Bearer some-real-looking-jwt' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /users/register', () => {
    it('creates a new profile and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: { ...authHeader('rina-1'), 'content-type': 'application/json' },
        payload: { displayName: 'Rina', preferredLanguage: 'hi-IN', role: 'citizen' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ uid: 'rina-1', displayName: 'Rina', role: 'citizen', fcmTokens: [] });
    });

    it('409s on a duplicate registration for the same uid', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('rina-2'),
        payload: { displayName: 'Rina', preferredLanguage: 'hi-IN', role: 'citizen' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('rina-2'),
        payload: { displayName: 'Rina Again', preferredLanguage: 'hi-IN', role: 'citizen' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CONFLICT');
    });

    it('400s on an empty displayName with Zod field-level detail', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('rina-3'),
        payload: { displayName: '', preferredLanguage: 'hi-IN', role: 'citizen' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /users/me', () => {
    it('404s when no profile exists yet', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeader('nobody') });
      expect(res.statusCode).toBe(404);
    });

    it('returns the profile once registered', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('anand-1'),
        payload: { displayName: 'Anand', preferredLanguage: 'en-IN', role: 'field_worker' },
      });
      const res = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeader('anand-1') });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe('field_worker');
    });
  });

  describe('PATCH /users/me', () => {
    it('404s when the profile does not exist', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me',
        headers: authHeader('ghost'),
        payload: { displayName: 'New Name' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('merges the patch and returns the updated document', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('rina-4'),
        payload: { displayName: 'Rina', preferredLanguage: 'en-IN', role: 'citizen' },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me',
        headers: authHeader('rina-4'),
        payload: { preferredLanguage: 'hi-IN' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.preferredLanguage).toBe('hi-IN');
      expect(body.displayName).toBe('Rina'); // untouched fields survive the merge
    });

    it('400s on an empty patch body', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('rina-5'),
        payload: { displayName: 'Rina', preferredLanguage: 'en-IN', role: 'citizen' },
      });
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: authHeader('rina-5'), payload: {} });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /submissions', () => {
    it('401s "Register before submitting a report" for an unregistered uid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/submissions',
        headers: authHeader('never-registered'),
        payload: {
          mediaType: 'photo',
          photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
          geo: { lat: 28.6, lng: 77.2 },
          capturedAt: now(),
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toMatch(/Register before submitting/);
    });

    it('202s with a computed h3Index + fallback jurisdiction, and publishes submission.created', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('rina-6'),
        payload: { displayName: 'Rina', preferredLanguage: 'en-IN', role: 'citizen' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/submissions',
        headers: authHeader('rina-6'),
        payload: {
          mediaType: 'photo',
          photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
          geo: { lat: 28.6129, lng: 77.2295 }, // India Gate
          capturedAt: now(),
        },
      });
      expect(res.statusCode).toBe(202);
      const { submission } = res.json();
      expect(submission.status).toBe('queued');
      expect(submission.userId).toBe('rina-6');
      // GOOGLE_MAPS_API_KEY isn't set in tests -> falls back to the
      // configured defaults, exercising the same path local dev without a
      // Maps key takes.
      expect(submission.jurisdiction).toEqual({ stateCode: 'DL', districtCode: 'DL-CENTRAL' });
      expect(submission.h3Index).toMatch(/^[0-9a-f]{15}$/i);

      expect(published).toHaveLength(1);
      expect(published[0]).toEqual({ topic: 'submission.created', payload: { submissionId: submission.id } });
    });

    it('400s on an out-of-range latitude', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('rina-7'),
        payload: { displayName: 'Rina', preferredLanguage: 'en-IN', role: 'citizen' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/submissions',
        headers: authHeader('rina-7'),
        payload: {
          mediaType: 'photo',
          photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
          geo: { lat: 999, lng: 77.2 },
          capturedAt: now(),
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /submissions/:id -- jurisdiction authorization', () => {
    async function registerCitizen(uid: string) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader(uid),
        payload: { displayName: uid, preferredLanguage: 'en-IN', role: 'citizen' },
      });
    }

    async function seedOfficial(uid: string, role: 'district_admin' | 'state_admin', jurisdiction: Record<string, string>) {
      // Officials are provisioned out-of-band (never via /users/register --
      // API_CONTRACTS.md), so seed the profile directly. getDb() is typed
      // against the real Firestore SDK; .seed() only exists on our fake,
      // hence the cast back to the concrete class this file already knows about.
      fakeDb.collection('users').seed(uid, {
        uid,
        displayName: uid,
        role,
        preferredLanguage: 'en-IN',
        jurisdiction,
        fcmTokens: [],
        createdAt: now(),
        updatedAt: now(),
      });
    }

    it('404s for a submission that does not exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/submissions/does-not-exist', headers: authHeader('anyone') });
      expect(res.statusCode).toBe(404);
    });

    it('the owner can always read their own submission', async () => {
      await registerCitizen('rina-8');
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/submissions',
        headers: authHeader('rina-8'),
        payload: {
          mediaType: 'photo',
          photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
          geo: { lat: 28.6, lng: 77.2 },
          capturedAt: now(),
        },
      });
      const { submission } = create.json();

      const res = await app.inject({ method: 'GET', url: `/api/v1/submissions/${submission.id}`, headers: authHeader('rina-8') });
      expect(res.statusCode).toBe(200);
      expect(res.json().submission.id).toBe(submission.id);
      expect(res.json().analysis).toBeNull(); // no analysis-service yet
    });

    it('a different citizen cannot read someone else\u2019s submission', async () => {
      await registerCitizen('rina-9');
      await registerCitizen('other-citizen');
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/submissions',
        headers: authHeader('rina-9'),
        payload: {
          mediaType: 'photo',
          photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
          geo: { lat: 28.6, lng: 77.2 },
          capturedAt: now(),
        },
      });
      const { submission } = create.json();

      const res = await app.inject({ method: 'GET', url: `/api/v1/submissions/${submission.id}`, headers: authHeader('other-citizen') });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN_JURISDICTION');
    });

    it('a district_admin in the SAME district can read it; a different district cannot', async () => {
      await registerCitizen('rina-10');
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/submissions',
        headers: authHeader('rina-10'),
        payload: {
          mediaType: 'photo',
          photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
          geo: { lat: 28.6, lng: 77.2 }, // falls back to DL / DL-CENTRAL
          capturedAt: now(),
        },
      });
      const { submission } = create.json();

      await seedOfficial('deshmukh', 'district_admin', { stateCode: 'DL', districtCode: 'DL-CENTRAL' });
      await seedOfficial('other-officer', 'district_admin', { stateCode: 'DL', districtCode: 'DL-NORTH' });

      const same = await app.inject({ method: 'GET', url: `/api/v1/submissions/${submission.id}`, headers: authHeader('deshmukh') });
      expect(same.statusCode).toBe(200);

      const different = await app.inject({ method: 'GET', url: `/api/v1/submissions/${submission.id}`, headers: authHeader('other-officer') });
      expect(different.statusCode).toBe(403);
    });

    it('a state_admin (no districtCode) can read any submission in their state', async () => {
      await registerCitizen('rina-11');
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/submissions',
        headers: authHeader('rina-11'),
        payload: {
          mediaType: 'photo',
          photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
          geo: { lat: 28.6, lng: 77.2 },
          capturedAt: now(),
        },
      });
      const { submission } = create.json();

      await seedOfficial('iyer', 'state_admin', { stateCode: 'DL' });
      const res = await app.inject({ method: 'GET', url: `/api/v1/submissions/${submission.id}`, headers: authHeader('iyer') });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /submissions -- never client-filtered for citizens', () => {
    it('a citizen only ever sees their own submissions, even if others exist', async () => {
      for (const uid of ['list-a', 'list-b']) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/users/register',
          headers: authHeader(uid),
          payload: { displayName: uid, preferredLanguage: 'en-IN', role: 'citizen' },
        });
        await app.inject({
          method: 'POST',
          url: '/api/v1/submissions',
          headers: authHeader(uid),
          payload: {
            mediaType: 'photo',
            photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
            geo: { lat: 28.6, lng: 77.2 },
            capturedAt: now(),
          },
        });
      }

      const res = await app.inject({ method: 'GET', url: '/api/v1/submissions', headers: authHeader('list-a') });
      expect(res.statusCode).toBe(200);
      const { items } = res.json();
      expect(items).toHaveLength(1);
      expect(items[0].userId).toBe('list-a');
    });
  });

  describe('POST /submissions/:id/retry-analysis', () => {
    it('409s if the submission is already analyzed', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('rina-12'),
        payload: { displayName: 'Rina', preferredLanguage: 'en-IN', role: 'citizen' },
      });
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/submissions',
        headers: authHeader('rina-12'),
        payload: {
          mediaType: 'photo',
          photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
          geo: { lat: 28.6, lng: 77.2 },
          capturedAt: now(),
        },
      });
      const { submission } = create.json();

      const { getDb } = await import('@vayusetu/gcp-clients');
      await getDb().collection('submissions').doc(submission.id).set({ ...submission, status: 'analyzed' }, { merge: true });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/submissions/${submission.id}/retry-analysis`,
        headers: authHeader('rina-12'),
      });
      expect(res.statusCode).toBe(409);
    });

    it('202s and re-publishes submission.created for a queued submission', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: authHeader('rina-13'),
        payload: { displayName: 'Rina', preferredLanguage: 'en-IN', role: 'citizen' },
      });
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/submissions',
        headers: authHeader('rina-13'),
        payload: {
          mediaType: 'photo',
          photoStorageUrl: 'https://storage.googleapis.com/example/a.jpg',
          geo: { lat: 28.6, lng: 77.2 },
          capturedAt: now(),
        },
      });
      const { submission } = create.json();
      published.length = 0; // clear the create-time publish so we isolate this call's publish

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/submissions/${submission.id}/retry-analysis`,
        headers: authHeader('rina-13'),
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().submission.status).toBe('pending_analysis');
      expect(published).toHaveLength(1);
    });
  });
});
