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
  createSignedReadUrl: async (gs: string) => `https://storage.googleapis.com/signed/${gs.slice(5)}?X-Goog-Signature=fake`,
  createSignedUploadUrl: async (args: { bucket: string; objectPath: string; contentType: string; maxBytes: number }) => {
    signCalls.push(args);
    return {
      uploadUrl: `https://storage.googleapis.com/${args.bucket}/${args.objectPath}?X-Goog-Signature=fake`,
      storageUrl: `gs://${args.bucket}/${args.objectPath}`,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      uploadHeaders: { 'x-goog-content-length-range': `0,${args.maxBytes}` },
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

    it('no API response is cacheable -- 404, 401 or 200 (the Hosting CDN replayed a 404 to every user)', async () => {
      const notYet = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth('cdn') });
      const anon = await app.inject({ method: 'GET', url: '/api/v1/users/me' });
      await register('cdn');
      const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth('cdn') });
      expect([notYet.statusCode, anon.statusCode, me.statusCode]).toEqual([404, 401, 200]);
      for (const res of [notYet, anon, me]) expect(res.headers['cache-control']).toBe('private, no-store');
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

    it('caps photos at 10 MB (audit H2)', async () => {
      await register('rina');
      expect((await sign('rina', { kind: 'photo', contentType: 'image/jpeg' })).statusCode).toBe(200);
      expect(signCalls[0]!.maxBytes).toBe(10 * 1024 * 1024);
    });

    it('issues a URL scoped under the caller\u2019s uid and signs the exact Content-Type sent', async () => {
      await register('rina');
      const res = await sign('rina', { kind: 'audio', contentType: 'audio/webm;codecs=opus' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.storageUrl).toMatch(/^gs:\/\/test-media\/submissions\/rina\/\d{4}-\d{2}-\d{2}\/audio-[0-9a-f-]{36}\.webm$/);
      expect(body.uploadUrl).toContain('X-Goog-Signature');
      expect(signCalls[0]).toMatchObject({ bucket: 'test-media', contentType: 'audio/webm;codecs=opus' });
      // Audit H2: the size cap is signed into the URL and returned for the client to send.
      expect(signCalls[0]!.maxBytes).toBe(2 * 1024 * 1024);
      expect(body.uploadHeaders).toEqual({ 'x-goog-content-length-range': '0,2097152' });
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

    const retry = (id: string, uid: string) =>
      app.inject({ method: 'POST', url: `/api/v1/submissions/${id}/retry-analysis`, headers: auth(uid) });
    const setDoc = (id: string, data: Record<string, unknown>) => fakeDb.collection('submissions').doc(id).set(data, { merge: true });

    it('202s and re-publishes a FAILED report for its reporter, counting retries', async () => {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      await setDoc(submission.id, { status: 'failed' });
      published.length = 0;
      const res = await retry(submission.id, 'rina');
      expect(res.statusCode).toBe(202);
      expect(res.json().submission).toMatchObject({ status: 'pending_analysis', retryCount: 1 });
      expect(published).toHaveLength(1);
    });

    it('audit M1: a reporter cannot re-run a flagged or fresh report, and is capped at 3 retries', async () => {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      expect((await retry(submission.id, 'rina')).statusCode).toBe(409); // queued, not stuck yet
      await setDoc(submission.id, { status: 'flagged_for_review' });
      expect((await retry(submission.id, 'rina')).statusCode).toBe(409); // a flag is an official's call
      await setDoc(submission.id, { status: 'failed', retryCount: 3 });
      expect((await retry(submission.id, 'rina')).statusCode).toBe(429);
    });

    it('a report stuck in queued for over 10 minutes is retryable by its reporter', async () => {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      await setDoc(submission.id, { uploadedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
      expect((await retry(submission.id, 'rina')).statusCode).toBe(202);
    });

    it('an official in scope can re-run a flagged report, without the reporter cap', async () => {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      await setDoc(submission.id, { status: 'flagged_for_review', retryCount: 5 });
      seedOfficial('iyer', 'state_admin', { stateCode: submission.jurisdiction.stateCode });
      expect((await retry(submission.id, 'iyer')).statusCode).toBe(202);
    });
  });
  describe('PATCH /users/me role upgrade (Phase 1 contract)', () => {
    it('lets a citizen become a field worker, one way', async () => {
      await register('anand');
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: auth('anand'), payload: { role: 'field_worker' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe('field_worker');
      const back = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: auth('anand'), payload: { role: 'citizen' } });
      expect(back.statusCode).toBe(400);
    });

    it('never lets an official self-assign a role', async () => {
      seedOfficial('deshmukh', 'district_admin', { stateCode: 'DL', districtCode: 'DL-CENTRAL' });
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: auth('deshmukh'), payload: { role: 'field_worker' } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('preferredLanguage is stored canonical', () => {
    it('register "en" -> en-IN; patch "hi" -> hi-IN', async () => {
      const reg = await app.inject({
        method: 'POST', url: '/api/v1/users/register', headers: auth('lang'),
        payload: { displayName: 'L', preferredLanguage: 'en', role: 'citizen' },
      });
      expect(reg.json().preferredLanguage).toBe('en-IN');
      const patch = await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: auth('lang'), payload: { preferredLanguage: 'hi' } });
      expect(patch.json().preferredLanguage).toBe('hi-IN');
    });
  });

  describe('fieldSensorReading', () => {
    it('is stored for field workers, dropped for citizens, bounded', async () => {
      await register('anand', 'field_worker');
      await register('rina');
      const fw = await submit('anand', { fieldSensorReading: { pm25: 182.5, pm10: 240 } });
      expect(fw.json().submission.fieldSensorReading).toEqual({ pm25: 182.5, pm10: 240 });
      const citizen = await submit('rina', { fieldSensorReading: { pm25: 99 } });
      expect(citizen.statusCode).toBe(202);
      expect(citizen.json().submission.fieldSensorReading).toBeUndefined();
      expect((await submit('anand', { fieldSensorReading: { pm25: 5000 } })).statusCode).toBe(400);
      expect((await submit('anand', { fieldSensorReading: {} })).statusCode).toBe(400);
    });
  });

  describe('GET /analysis/:submissionId', () => {
    it('returns status + null result while analysis is pending', async () => {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      const res = await app.inject({ method: 'GET', url: `/api/v1/analysis/${submission.id}`, headers: auth('rina') });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'queued', result: null });
    });

    it('swaps the private gs:// advisory audio for a signed https URL', async () => {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      fakeDb.collection('analysisResults').seed(submission.id, {
        submissionId: submission.id,
        sourceClassification: 'vehicular_smog',
        advisory: { text: 't', language: 'hi-IN', audioStorageUrl: 'gs://audio/tts/hi-IN/x.mp3' },
      });
      const res = await app.inject({ method: 'GET', url: `/api/v1/analysis/${submission.id}`, headers: auth('rina') });
      expect(res.json().result.advisory.audioStorageUrl).toBe('https://storage.googleapis.com/signed/audio/tts/hi-IN/x.mp3?X-Goog-Signature=fake');
      const viaSubmission = await app.inject({ method: 'GET', url: `/api/v1/submissions/${submission.id}`, headers: auth('rina') });
      expect(viaSubmission.json().analysis.advisory.audioStorageUrl).toMatch(/^https:/);
    });

    it('applies the parent submission authorization', async () => {
      await register('rina');
      await register('other');
      const { submission } = (await submit('rina')).json();
      const res = await app.inject({ method: 'GET', url: `/api/v1/analysis/${submission.id}`, headers: auth('other') });
      expect(res.statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/v1/analysis/nope', headers: auth('rina') })).statusCode).toBe(404);
    });
  });

  describe('POST /submissions/:id/clarify (Pipeline D)', () => {
    async function withQuestion() {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      await fakeDb.collection('submissions').doc(submission.id).set(
        { status: 'flagged_for_review', clarifications: [{ turn: 1, question: 'Field or chimney?', language: 'en-IN', askedAt: now() }] },
        { merge: true },
      );
      fakeDb.collection('analysisResults').seed(submission.id, {
        submissionId: submission.id,
        advisory: { text: 't', language: 'en-IN' },
        pendingClarification: { turn: 1, question: 'Field or chimney?', language: 'en-IN' },
      });
      published.length = 0;
      return submission.id as string;
    }

    it('records the answer, resets to pending_analysis and re-publishes', async () => {
      const id = await withQuestion();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/submissions/${id}/clarify`,
        headers: auth('rina'),
        payload: { answerText: 'A field, far away', answerPhotoStorageUrl: photoUrl('rina', 'b.jpg') },
      });
      expect(res.statusCode).toBe(202);
      const stored = (await fakeDb.collection('submissions').doc(id).get()).data() as {
        status: string;
        clarifications: Array<Record<string, unknown>>;
      };
      expect(stored.status).toBe('pending_analysis');
      expect(stored.clarifications[0]).toMatchObject({
        turn: 1,
        answerText: 'A field, far away',
        answerPhotoStorageUrl: photoUrl('rina', 'b.jpg'),
        answeredAt: expect.any(String),
      });
      expect(published).toEqual([{ topic: 'submission.created', payload: { submissionId: id } }]);
      const again = await app.inject({ method: 'POST', url: `/api/v1/submissions/${id}/clarify`, headers: auth('rina'), payload: { answerText: 'x' } });
      expect(again.statusCode).toBe(409);
    });

    it('rejects other users, empty answers, foreign photos, and reports with no question', async () => {
      const id = await withQuestion();
      await register('other');
      const post = (uid: string, sid: string, payload: object) =>
        app.inject({ method: 'POST', url: `/api/v1/submissions/${sid}/clarify`, headers: auth(uid), payload });
      expect((await post('other', id, { answerText: 'x' })).statusCode).toBe(403);
      expect((await post('rina', id, {})).statusCode).toBe(400);
      expect((await post('rina', id, { answerPhotoStorageUrl: photoUrl('other') })).statusCode).toBe(400);
      const { submission } = (await submit('rina')).json();
      expect((await post('rina', submission.id, { answerText: 'x' })).statusCode).toBe(409);
    });
  });

  describe('retry-analysis keeps fields written by analysis-service', () => {
    it('does not clobber the transcript', async () => {
      await register('rina');
      const { submission } = (await submit('rina')).json();
      await fakeDb.collection('submissions').doc(submission.id).set({ status: 'failed', transcript: 'dhuan' }, { merge: true });
      await app.inject({ method: 'POST', url: `/api/v1/submissions/${submission.id}/retry-analysis`, headers: auth('rina') });
      const stored = (await fakeDb.collection('submissions').doc(submission.id).get()).data() as { transcript: string; status: string };
      expect(stored).toMatchObject({ transcript: 'dhuan', status: 'pending_analysis' });
    });
  });

  describe('GET /corridors', () => {
    it('lists and gets corridors; 404 for unknown; auth required', async () => {
      await register('rina');
      fakeDb.collection('corridors').seed('ncr-airshed', { id: 'ncr-airshed', name: 'Delhi-NCR Airshed', states: ['DL'] });
      fakeDb.collection('corridors').seed('mumbai-pune-corridor', { id: 'mumbai-pune-corridor', name: 'Mumbai-Pune', states: ['MH'] });
      const list = await app.inject({ method: 'GET', url: '/api/v1/corridors', headers: auth('rina') });
      expect(list.json().corridors.map((c: { id: string }) => c.id)).toEqual(['mumbai-pune-corridor', 'ncr-airshed']);
      expect((await app.inject({ method: 'GET', url: '/api/v1/corridors/ncr-airshed', headers: auth('rina') })).json().name).toBe('Delhi-NCR Airshed');
      expect((await app.inject({ method: 'GET', url: '/api/v1/corridors/nope', headers: auth('rina') })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/v1/corridors' })).statusCode).toBe(401);
    });
  });

  describe('/resources/requests (Resource Coordination)', () => {
    const create = (uid: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/v1/resources/requests', headers: auth(uid), payload });
    const list = (uid: string, qs = '') => app.inject({ method: 'GET', url: `/api/v1/resources/requests${qs}`, headers: auth(uid) });

    beforeEach(() => {
      seedOfficial('deshmukh', 'district_admin', { stateCode: 'DL', districtCode: 'DL-CENTRAL' });
      seedOfficial('east', 'district_admin', { stateCode: 'DL', districtCode: 'DL-EAST' });
      seedOfficial('iyer', 'state_admin', { stateCode: 'DL' });
      seedOfficial('patil', 'state_admin', { stateCode: 'MH' });
      seedOfficial('root', 'super_admin');
    });

    it('takes jurisdiction from the caller profile, never the body', async () => {
      const res = await create('deshmukh', { resourceType: 'anti_smog_gun', quantityNeeded: 3, jurisdiction: { stateCode: 'MH' } });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        jurisdiction: { stateCode: 'DL', districtCode: 'DL-CENTRAL' },
        status: 'open',
        createdBy: 'deshmukh',
        quantityNeeded: 3,
      });
    });

    it('validates the related alert and its jurisdiction', async () => {
      fakeDb.collection('alerts').seed('a-central', { id: 'a-central', assignedJurisdiction: { stateCode: 'DL', districtCode: 'DL-CENTRAL' } });
      fakeDb.collection('alerts').seed('a-east', { id: 'a-east', assignedJurisdiction: { stateCode: 'DL', districtCode: 'DL-EAST' } });
      expect((await create('deshmukh', { resourceType: 'water_sprinkler', quantityNeeded: 2, relatedAlertId: 'a-central' })).statusCode).toBe(201);
      expect((await create('deshmukh', { resourceType: 'water_sprinkler', quantityNeeded: 2, relatedAlertId: 'a-east' })).statusCode).toBe(403);
      expect((await create('deshmukh', { resourceType: 'water_sprinkler', quantityNeeded: 2, relatedAlertId: 'ghost' })).statusCode).toBe(400);
      expect((await create('deshmukh', { resourceType: 'tank', quantityNeeded: 2 })).statusCode).toBe(400);
    });

    it('citizens and super_admins cannot raise requests', async () => {
      await register('rina');
      expect((await create('rina', { resourceType: 'other', quantityNeeded: 1 })).statusCode).toBe(403);
      expect((await create('root', { resourceType: 'other', quantityNeeded: 1 })).statusCode).toBe(403);
      expect((await list('rina')).statusCode).toBe(403);
    });

    it('scopes the board: district -> own district, state -> own state, super_admin -> all', async () => {
      await create('deshmukh', { resourceType: 'anti_smog_gun', quantityNeeded: 1 });
      await create('east', { resourceType: 'inspection_team', quantityNeeded: 1 });
      await create('patil', { resourceType: 'mobile_monitoring_van', quantityNeeded: 1 });
      expect((await list('deshmukh')).json().items.map((r: { createdBy: string }) => r.createdBy)).toEqual(['deshmukh']);
      expect((await list('iyer')).json().totalCount).toBe(2);
      expect((await list('root')).json().totalCount).toBe(3);
      expect((await list('root', '?status=fulfilled')).json().totalCount).toBe(0);
    });
  });
});
