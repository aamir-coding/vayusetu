import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeFirestore } from '@vayusetu/gcp-clients/testing';

const fakeDb = new FakeFirestore();

vi.mock('@vayusetu/gcp-clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vayusetu/gcp-clients')>()),
  getDb: () => fakeDb,
  getAdminAppCheck: () => {
    throw new Error('tests inject a verifier; the real App Check client must not be used');
  },
}));

process.env.AUTH_MODE = 'mock';
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLOUD_PROJECT = 'vayusetu-test';
process.env.MEDIA_BUCKET = 'test-media';

const { buildApp } = await import('../src/app.js');

const verify = async (token: string) => {
  if (token !== 'good-app-token') throw new Error('bad App Check token');
  return {};
};
const register = (app: FastifyInstance, appCheckToken?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/users/register',
    headers: { authorization: 'Bearer mock-token:rina', ...(appCheckToken ? { 'x-firebase-appcheck': appCheckToken } : {}) },
    payload: { displayName: 'Rina', preferredLanguage: 'hi-IN', role: 'citizen' },
  });

describe('App Check (audit H1)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    fakeDb.reset();
    await app.close();
  });

  it('enforce: rejects a citizen write with no or a forged token, accepts a valid one', async () => {
    app = await buildApp({ appCheck: { mode: 'enforce', verify } });
    expect((await register(app)).statusCode).toBe(401);
    expect((await register(app, 'forged')).statusCode).toBe(401);
    expect((await register(app, 'good-app-token')).statusCode).toBe(201);
  });

  it('enforce: leaves reads and officials’ routes alone (admin dashboard sends no token)', async () => {
    app = await buildApp({ appCheck: { mode: 'enforce', verify } });
    await register(app, 'good-app-token');
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: { authorization: 'Bearer mock-token:rina' } });
    expect(me.statusCode).toBe(200);
  });

  it('monitor: logs but lets the request through', async () => {
    app = await buildApp({ appCheck: { mode: 'monitor', verify } });
    expect((await register(app)).statusCode).toBe(201);
  });

  it('auth still runs first: no ID token is a 401 before App Check is consulted', async () => {
    const spy = vi.fn(verify);
    app = await buildApp({ appCheck: { mode: 'enforce', verify: spy } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/users/register', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });
});
