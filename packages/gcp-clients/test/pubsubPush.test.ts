import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PushAuthError, createPushVerifier, decodePush } from '../src/pubsubPush.js';
import { parseGsUrl } from '../src/storage.js';

const envelope = (payload: unknown) => ({
  message: { data: Buffer.from(JSON.stringify(payload)).toString('base64'), messageId: 'm1' },
  deliveryAttempt: 2,
});

describe('decodePush', () => {
  const schema = z.object({ submissionId: z.string().min(1) });

  it('decodes a valid envelope', () => {
    expect(decodePush(envelope({ submissionId: 's1' }), schema)).toEqual({
      ok: true,
      payload: { submissionId: 's1' },
      messageId: 'm1',
      deliveryAttempt: 2,
    });
  });

  it('rejects malformed envelopes and contract violations', () => {
    expect(decodePush({ nope: 1 }, schema)).toMatchObject({ ok: false, reason: 'malformed envelope' });
    expect(decodePush({ message: { data: '!!!' } }, schema)).toMatchObject({ ok: false });
    expect(decodePush(envelope({ submissionId: '' }), schema)).toMatchObject({ ok: false, reason: expect.stringContaining('4.3') });
  });
});

describe('createPushVerifier', () => {
  const SA = 'pubsub-push@p.iam.gserviceaccount.com';
  const verifier = (claims: object) =>
    createPushVerifier({ mode: 'oidc', audience: 'aud', serviceAccountEmail: SA, verify: async () => claims });

  it('accepts the exact push SA with a verified email', async () => {
    await expect(verifier({ email: SA, email_verified: true })('Bearer t')).resolves.toBeUndefined();
  });

  it('rejects a missing token, another SA, an unverified email', async () => {
    await expect(verifier({ email: SA, email_verified: true })(undefined)).rejects.toBeInstanceOf(PushAuthError);
    await expect(verifier({ email: 'evil@x.iam.gserviceaccount.com', email_verified: true })('Bearer t')).rejects.toThrow(
      'expected service account',
    );
    await expect(verifier({ email: SA })('Bearer t')).rejects.toThrow();
  });

  it('refuses to build an oidc verifier without audience/SA', () => {
    expect(() => createPushVerifier({ mode: 'oidc' })).toThrow('required');
  });

  it('off mode lets everything through (emulator only)', async () => {
    await expect(createPushVerifier({ mode: 'off' })(undefined)).resolves.toBeUndefined();
  });
});

describe('parseGsUrl', () => {
  it('splits bucket and path', () => {
    expect(parseGsUrl('gs://b/tts/abc.mp3')).toEqual({ bucket: 'b', path: 'tts/abc.mp3' });
    expect(parseGsUrl('https://x/y')).toBeUndefined();
  });
});
