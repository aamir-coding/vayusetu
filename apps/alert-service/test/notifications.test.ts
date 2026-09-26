import { describe, expect, it, vi } from 'vitest';
import type { Alert } from '@vayusetu/shared-types';
import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';
import { createFcmChannel } from '../src/notifications/fcmChannel.js';
import { createNotificationGateway, createStubChannel, toNotificationsSent } from '../src/notifications/gateway.js';
import type { ChannelAdapter, Recipient } from '../src/notifications/types.js';

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const msg = { alertId: 'a1', severity: 'critical' as const, title: 't', body: 'b', deepLink: 'http://localhost:5174/alerts/a1' };
const rcpt = (uid: string, fcmTokens: string[], phoneNumber?: string): Recipient => ({
  uid,
  role: 'district_admin',
  fcmTokens,
  preferredLanguage: 'en-IN',
  ...(phoneNumber ? { phoneNumber } : {}),
});

/** Fake FCM: tokens listed in `failures` fail with the given error code. */
function fakeMessaging(failures: Record<string, string> = {}) {
  const calls: MulticastMessage[] = [];
  return {
    calls,
    sendEachForMulticast: vi.fn(async (m: MulticastMessage): Promise<BatchResponse> => {
      calls.push(m);
      const responses = m.tokens.map((t) =>
        failures[t]
          ? { success: false as const, error: { code: failures[t] } as never }
          : { success: true as const, messageId: `m-${t}` },
      );
      return { responses, successCount: responses.filter((r) => r.success).length, failureCount: 0 };
    }),
  };
}

describe('FCM channel', () => {
  it('chunks at the 500-token multicast limit', async () => {
    const messaging = fakeMessaging();
    const tokens = Array.from({ length: 1201 }, (_, i) => `tok-${i}`);
    const ch = createFcmChannel({ messaging, removeDeadTokens: vi.fn(), logger: silent });
    await ch.send([rcpt('u1', tokens)], msg);
    expect(messaging.calls.map((c) => c.tokens.length)).toEqual([500, 500, 201]);
  });

  it('a user is "sent" if ANY device accepted; users with no token are recorded "failed"', async () => {
    const messaging = fakeMessaging({ 'd-old': 'messaging/registration-token-not-registered' });
    const ch = createFcmChannel({ messaging, removeDeadTokens: vi.fn(), logger: silent });
    const results = await ch.send([rcpt('deshmukh', ['d-old', 'd-new']), rcpt('no-device', [])], msg);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'deshmukh', status: 'sent', simulated: false }),
        expect.objectContaining({ to: 'no-device', status: 'failed', detail: 'no registered FCM token' }),
      ]),
    );
  });

  it('prunes only permanently-dead tokens, never on invalid-argument (payload errors)', async () => {
    const messaging = fakeMessaging({
      dead1: 'messaging/registration-token-not-registered',
      dead2: 'messaging/invalid-registration-token',
      payloadErr: 'messaging/invalid-argument',
    });
    const removeDeadTokens = vi.fn(async () => {});
    const ch = createFcmChannel({ messaging, removeDeadTokens, logger: silent });
    await ch.send([rcpt('u1', ['dead1', 'dead2', 'payloadErr', 'ok'])], msg);
    expect(removeDeadTokens).toHaveBeenCalledOnce();
    expect(removeDeadTokens).toHaveBeenCalledWith('u1', ['dead1', 'dead2']);
  });

  it('omits webpush.fcmOptions.link for non-https links (FCM would reject the whole batch)', async () => {
    const messaging = fakeMessaging();
    const ch = createFcmChannel({ messaging, removeDeadTokens: vi.fn(), logger: silent });
    await ch.send([rcpt('u1', ['t'])], msg);
    await ch.send([rcpt('u1', ['t'])], { ...msg, deepLink: 'https://admin.vayusetu.app/alerts/a1' });
    expect(messaging.calls[0]!.webpush?.fcmOptions).toBeUndefined();
    expect(messaging.calls[0]!.data?.link).toBe(msg.deepLink);
    expect(messaging.calls[1]!.webpush?.fcmOptions?.link).toBe('https://admin.vayusetu.app/alerts/a1');
  });
});

describe('notification gateway', () => {
  const alert = (severity: Alert['severity']) =>
    ({
      id: 'a1',
      severity,
      title: 'Hotspot',
      description: 'Something happened. More detail.',
      recommendedActions: ['Do the thing', 'Do another'],
    }) as Alert;

  function recordingPush(): ChannelAdapter & { sends: number } {
    const a = {
      channel: 'push' as const,
      mode: 'live' as const,
      sends: 0,
      async send(rs: Recipient[]) {
        a.sends++;
        return rs.map((r) => ({ channel: 'push' as const, to: r.uid, status: 'sent' as const, simulated: false }));
      },
    };
    return a;
  }

  const officials = [rcpt('deshmukh', ['t1'], '+919800000001'), rcpt('iyer', ['t2'])];

  it('fans out by severity: watch=push, warning=+sms, critical=+whatsapp', async () => {
    const gw = createNotificationGateway({
      adapters: { push: recordingPush(), sms: createStubChannel('sms', silent), whatsapp: createStubChannel('whatsapp', silent) },
      dashboardBaseUrl: 'http://x',
      logger: silent,
    });
    const channelsFor = async (s: Alert['severity']) => [...new Set((await gw.dispatch(alert(s), officials)).map((r) => r.channel))];
    expect(await channelsFor('watch')).toEqual(['push']);
    expect(await channelsFor('warning')).toEqual(['push', 'sms']);
    expect(await channelsFor('critical')).toEqual(['push', 'sms', 'whatsapp']);
  });

  it('stubs skip recipients without a phone and are never persisted to notificationsSent', async () => {
    const gw = createNotificationGateway({
      adapters: { push: recordingPush(), sms: createStubChannel('sms', silent) },
      dashboardBaseUrl: 'http://x',
      logger: silent,
    });
    const results = await gw.dispatch(alert('warning'), officials);
    expect(results.filter((r) => r.channel === 'sms').map((r) => r.to)).toEqual(['deshmukh']); // iyer has no phone
    const persisted = toNotificationsSent(results, '2026-09-24T00:00:00.000Z');
    expect(persisted.every((p) => p.channel === 'push')).toBe(true);
  });

  it('one channel failing (SMS gateway down) does not stop push', async () => {
    const push = recordingPush();
    const brokenSms: ChannelAdapter = { channel: 'sms', mode: 'live', send: async () => Promise.reject(new Error('gateway 503')) };
    const gw = createNotificationGateway({ adapters: { push, sms: brokenSms }, dashboardBaseUrl: 'http://x', logger: silent });
    const results = await gw.dispatch(alert('warning'), officials);
    expect(push.sends).toBe(1);
    expect(results.filter((r) => r.channel === 'sms').every((r) => r.status === 'failed')).toBe(true);
    expect(results.filter((r) => r.channel === 'push').every((r) => r.status === 'sent')).toBe(true);
  });
});
