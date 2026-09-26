import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeFirestore } from '@vayusetu/gcp-clients/testing';

const fakeDb = new FakeFirestore();
const published: Array<{ topic: string; payload: unknown }> = [];
const signCalls: Array<Record<string, unknown>> = [];

// Keep the REAL geocoding resolver/GeocodingError (so the no-key fallback
// path is exercised for real); replace only the GCP I/O.
vi.mock('@vayusetu/gcp-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vayusetu/gcp-clients')>()),
  getDb: () => fakeDb,
  getAdminAuth: () => {
    throw new Error('getAdminAuth() should never be called while AUTH_MODE=mock');
  },
  publishEvent: async (topic: string, payload: unknown) => {
    published.push({ topic, payload });
    return 'fake-message-id';
  },
  createSignedUploadUrl: async (args: { bucket: string; objectPath: string; contentType: string }) => {
    signCalls.push(args);
    return {
      uploadUrl: `https://storage.googleapis.com/${args.bucket}/${args.objectPath}?X-Goog-Signature=fake`,
      storageUrl: `gs://${args.bucket}/${args.objectPath}`,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
  },
}));

// env.ts parses process.env at import time -> set before the dynamic import.
process.env.AUTH_MODE = 'mock';
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLOUD_PROJECT = 'vayusetu-test';
process.env.DEFAULT_STATE_CODE = 'DL';
process.env.DEFAULT_DISTRICT_CODE = 'DL-CENTRAL';
process.env.CORS_ORIGIN = '*';
process.env.MEDIA_BUCKET = 'test-media';

const { buildApp } = await import('../src/app.js');
const { jurisdictionResolver } = await import('../src/lib/reverseGeocode.js');
const { GeocodingError } = await import('@vayusetu/gcp-clients');

const auth = (uid: string) => ({ authorization: `Bearer mock-token:${uid}` });
const now = () => new Date().toISOString();
const photoUrl = (uid: string, name = 'a.jpg') => `gs://test-media/submissions/${uid}/2026-09-24/photo-${name}`;

describe('submission-service', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    fakeDb.reset();
    published.length = 0;
    signCalls.length = 0;
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function register(uid: string, role: 'citizen' | 'field_worker' = 'citizen') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users/register',
      headers: auth(uid),
      payload: { displayName: uid, preferredLanguage: 'en-IN', role },
    });
    expect(res.statusCode).toBe(201);
  }

  async function submit(uid: string, overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/submissions',
      headers: auth(uid),
      payload: {
        mediaType: 'photo',
        photoStorageUrl: photoUrl(uid),
        geo: { lat: 28.6129, lng: 77.2295 },
        capturedAt: now(),
        ...overrides,
      },
    });
  }

  function seedOfficial(uid: string, role: 'district_admin' | 'state_admin' | 'super_admin', jurisdiction?: object) {
    fakeDb.collection('users').seed(uid, {
      uid,
      displayName: uid,
      role,
      preferredLanguage: 'en-IN',
      ...(jurisdiction ? { jurisdiction } : {}),
      fcmTokens: [],
      createdAt: now(),
      updatedAt: now(),
    });
  }

  // ------------------------------------------------------------------ infra
  describe('envelope + infra', () => {
    it('GET /health responds 200 with no auth header', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, service: 'submission-service' });
    });

    it('REGRESSION: unknown routes return the ApiError envelope, not Fastify\u2019s default shape', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/nope', headers: auth('x') });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });

    it('REGRESSION: rate limiting returns 429 RATE_LIMITED (Week 1 said VALIDATION_ERROR), keyed per user', async () => {
      await app.close();
      app = await buildApp({ rateLimitMax: 2 });
      await register('busy'); // request 1 for "busy"
      await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth('busy') }); // 2
      const limited = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth('busy') }); // 3
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');

      // A different user on the same IP is unaffected -- the CGNAT case.
      const other = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth('someone-else') });
      expect(other.statusCode).toBe(404);
    });
  });

  // ------------------------------------------------------------------- auth
  describe('auth', () => {
    it('rejects a protected route with no Authorization header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/users/me' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });

    it('rejects a non-Bearer header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: { authorization: 'Basic dXNlcjpwYXNz' } });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a Bearer token that is not mock-token:<uid> in AUTH_MODE=mock', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: { authorization: 'Bearer eyJhbGc' } });
      expect(res.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------ users
  describe('users', () => {
    it('POST /users/register creates a profile (201)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: auth('rina'),
        payload: { displayName: 'Rina', preferredLanguage: 'hi-IN', role: 'citizen' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ uid: 'rina', role: 'citizen', fcmTokens: [] });
    });

    it('POST /users/register 409s on duplicate', async () => {
      await register('rina');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: auth('rina'),
        payload: { displayName: 'Again', preferredLanguage: 'hi-IN', role: 'citizen' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('POST /users/register 400s on empty displayName', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users/register',
        headers: auth('rina'),
        payload: { displayName: '', preferredLanguage: 'hi-IN', role: 'citizen' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('GET /users/me 404s before registration, 200s after', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth('anand') })).statusCode).toBe(404);
      await register('anand', 'field_worker');
      const res = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth('anand') });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe('field_worker');
    });

    it('PATCH /users/me 404s without a profile, merges with one, 400s on empty body', async () => {
      expect(
        (await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: auth('ghost'), payload: { displayName: 'x' } }))
          .statusCode,
      ).toBe(404);
      await register('rina');
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: auth('rina'), payload: { preferredLanguage: 'hi-IN' } });
      expect(res.json()).toMatchObject({ preferredLanguage: 'hi-IN', displayName: 'rina' });
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: auth('rina'), payload: {} })).statusCode).toBe(400);
    });

    it('PATCH /users/me de-duplicates fcmTokens and keeps the 10 most recent', async () => {
      await register('rina');
      const tok = (i: number) => `fcm-token-${String(i).padStart(3, '0')}-xxxxxxxxxxxx`;
      const tokens = [...Array.from({ length: 12 }, (_, i) => tok(i)), tok(11)];
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: auth('rina'), payload: { fcmTokens: tokens } });
      expect(res.statusCode).toBe(200);
      expect(res.json().fcmTokens).toEqual(Array.from({ length: 10 }, (_, i) => tok(i + 2)));
    });
  });

  // ------------------------------------------------------------ upload-url
  describe('POST /submissions/upload-url (proposed contract addition)', () => {
    const sign = (uid: string, payload: object) =>
      app.inject({ method: 'POST', url: '/api/v1/submissions/upload-url', headers: auth(uid), payload });

    it('401s for an unregistered caller', async () => {
      expect((await sign('nobody', { kind: 'photo', contentType: 'image/jpeg' })).statusCode).toBe(401);
    });

    it('403s for officials -- only citizens/field workers upload report media', async () => {
      seedOfficial('iyer', 'state_admin', { stateCode: 'DL' });
      expect((await sign('iyer', { kind: 'photo', contentType: 'image/jpeg' })).statusCode).toBe(403);
    });

    it('400s on a content type that does not match the kind', async () => {
      await register('rina');
      const res = await sign('rina', { kind: 'photo', contentType: 'application/pdf' });
      expect(res.statusCode).toBe(400);
    });

    it('issues a URL scoped under the caller\u2019s uid and signs the exact Content-Type sent', async () => {
      await register('rina');
      const res = await sign('rina', { kind: 'audio', contentType: 'audio/webm;codecs=opus' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.storageUrl).toMatch(/^gs:\/\/test-media\/submissions\/rina\/\d{4}-\d{2}-\d{2}\/audio-[0-9a-f-]{36}\.webm$/);
      expect(body.uploadUrl).toContain('X-Goog-Signature');
      expect(signCalls[0]).toMatchObject({ bucket: 'test-media', contentType: 'audio/webm;codecs=opus' });
    });
  });

  // ------------------------------------------------------------ submissions
  describe('POST /submissions', () => {
    it('401s for an unregistered uid', async () => {
      const res = await submit('never-registered');
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toMatch(/Register before submitting/);
    });

    it('202s with computed h3Index + fallback jurisdiction, and publishes submission.created', async () => {
      await register('rina');
      const res = await submit('rina');
      expect(res.statusCode).toBe(202);
      const { submission } = res.json();
      expect(submission).toMatchObject({ status: 'queued', userId: 'rina', jurisdiction: { stateCode: 'DL', districtCode: 'DL-CENTRAL' } });
      expect(submission.h3Index).toMatch(/^[0-9a-f]{15}$/i);
      expect(published).toEqual([{ topic: 'submission.created', payload: { submissionId: submission.id } }]);
    });

    it('400s on out-of-range latitude and on a non-ISO capturedAt', async () => {
      await register('rina');
      expect((await submit('rina', { geo: { lat: 999, lng: 77 } })).statusCode).toBe(400);
      expect((await submit('rina', { capturedAt: 'yesterday' })).statusCode).toBe(400);
    });

    it('400s on photo_audio without an audioStorageUrl', async () => {
      await register('rina');
      expect((await submit('rina', { mediaType: 'photo_audio' })).statusCode).toBe(400);
    });

    it('SECURITY: 400s on media under another user\u2019s prefix, or any external URL', async () => {
      await register('rina');
      expect((await submit('rina', { photoStorageUrl: photoUrl('someone-else') })).statusCode).toBe(400);
      expect((await submit('rina', { photoStorageUrl: 'https://evil.example.com/x.jpg' })).statusCode).toBe(400);
    });

    it('maps a no_result geocoding failure to 400, and a transient one to 500 without writing anything', async () => {
      await register('rina');
      const spy = vi.spyOn(jurisdictionResolver, 'resolve');

      spy.mockRejectedValueOnce(new GeocodingError('none', 'no_result'));
      expect((await submit('rina')).statusCode).toBe(400);

      spy.mockRejectedValueOnce(new GeocodingError('timeout', 'transient'));
      const res = await submit('rina');
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('INTERNAL_ERROR');

      expect(fakeDb.collection('submissions').all()).toHaveLength(0);
      expect(published).toHaveLength(0);
    });
  });

  describe('GET /submissions/:id -- jurisdiction authorization', () => {
    async function createAs(uid: string) {
      await register(uid);
      return (await submit(uid)).json().submission as { id: string };
    }

    it('404s for a missing submission', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/v1/submissions/nope', headers: auth('x') })).statusCode).toBe(404);
    });

    it('owner can read; another citizen gets 403', async () => {
      const s = await createAs('rina');
      await register('other');
      const own = await app.inject({ method: 'GET', url: `/api/v1/submissions/${s.id}`, headers: auth('rina') });
      expect(own.statusCode).toBe(200);
      expect(own.json().analysis).toBeNull();
      const other = await app.inject({ method: 'GET', url: `/api/v1/submissions/${s.id}`, headers: auth('other') });
      expect(other.statusCode).toBe(403);
      expect(other.json().error.code).toBe('FORBIDDEN_JURISDICTION');
    });

    it('same-district admin reads; other-district admin 403s; state admin reads', async () => {
      const s = await createAs('rina');
      seedOfficial('deshmukh', 'district_admin', { stateCode: 'DL', districtCode: 'DL-CENTRAL' });
      seedOfficial('north', 'district_admin', { stateCode: 'DL', districtCode: 'DL-NORTH' });
      seedOfficial('iyer', 'state_admin', { stateCode: 'DL' });
      const get = (uid: string) => app.inject({ method: 'GET', url: `/api/v1/submissions/${s.id}`, headers: auth(uid) });
      expect((await get('deshmukh')).statusCode).toBe(200);
      expect((await get('north')).statusCode).toBe(403);
      expect((await get('iyer')).statusCode).toBe(200);
    });
  });

  describe('GET /submissions -- scoping and pagination', () => {
    it('a citizen sees only their own, even when passing ?userId= for someone else', async () => {
      for (const uid of ['a', 'b']) {
        await register(uid);
        await submit(uid);
      }
      const res = await app.inject({ method: 'GET', url: '/api/v1/submissions?userId=b', headers: auth('a') });
      expect(res.json().items.map((s: { userId: string }) => s.userId)).toEqual(['a']);
    });

    it('an official can narrow by ?userId= within their jurisdiction', async () => {
      for (const uid of ['a', 'b']) {
        await register(uid);
        await submit(uid);
      }
      seedOfficial('iyer', 'state_admin', { stateCode: 'DL' });
      const all = await app.inject({ method: 'GET', url: '/api/v1/submissions', headers: auth('iyer') });
      expect(all.json().totalCount).toBe(2);
      const one = await app.inject({ method: 'GET', url: '/api/v1/submissions?userId=b', headers: auth('iyer') });
      expect(one.json().items.map((s: { userId: string }) => s.userId)).toEqual(['b']);
    });

    it('REGRESSION: nextPageToken only when the page is full; totalCount is the real total', async () => {
      await register('rina');
      for (let i = 0; i < 3; i++) await submit('rina', { photoStorageUrl: photoUrl('rina', `${i}.jpg`) });

      const p1 = (await app.inject({ method: 'GET', url: '/api/v1/submissions?pageSize=2', headers: auth('rina') })).json();
      expect(p1.items).toHaveLength(2);
      expect(p1.totalCount).toBe(3);
      expect(p1.nextPageToken).toBeTruthy();

      const p2 = (
        await app.inject({ method: 'GET', url: `/api/v1/submissions?pageSize=2&pageToken=${p1.nextPageToken}`, headers: auth('rina') })
      ).json();
      expect(p2.items).toHaveLength(1);
      expect(p2.nextPageToken).toBeUndefined();

      const ids = [...p1.items, ...p2.items].map((s: { id: string }) => s.id);
      expect(new Set(ids).size).toBe(3); // no duplicates, nothing skipped
    });

    it('400s on an invalid status or pageToken', async () => {
      await register('rina');
      expect((await app.inject({ method: 'GET', url: '/api/v1/submissions?status=bogus', headers: auth('rina') })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/v1/submissions?pageToken=%%%', headers: auth('rina') })).statusCode).toBe(400);
    });
  });

  describe('POST /submissions/:id/retry-analysis', () => {
    it('409s when already analyzed', async () => {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      await fakeDb.collection('submissions').doc(submission.id).set({ status: 'analyzed' }, { merge: true });
      const res = await app.inject({ method: 'POST', url: `/api/v1/submissions/${submission.id}/retry-analysis`, headers: auth('rina') });
      expect(res.statusCode).toBe(409);
    });

    it('202s and re-publishes for a queued submission; flagged_for_review is retryable too', async () => {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      published.length = 0;
      const res = await app.inject({ method: 'POST', url: `/api/v1/submissions/${submission.id}/retry-analysis`, headers: auth('rina') });
      expect(res.statusCode).toBe(202);
      expect(res.json().submission.status).toBe('pending_analysis');
      expect(published).toHaveLength(1);

      await fakeDb.collection('submissions').doc(submission.id).set({ status: 'flagged_for_review' }, { merge: true });
      const again = await app.inject({ method: 'POST', url: `/api/v1/submissions/${submission.id}/retry-analysis`, headers: auth('rina') });
      expect(again.statusCode).toBe(202);
    });
  });
});
