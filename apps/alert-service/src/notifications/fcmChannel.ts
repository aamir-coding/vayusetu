import type { Messaging, MulticastMessage } from 'firebase-admin/messaging';
import type { ChannelAdapter, DeliveryResult, OutboundMessage, Recipient } from './types.js';

const FCM_MULTICAST_LIMIT = 500;

/** Error codes that mean "this token will never work again" -> prune it.
 *  'messaging/invalid-argument' is deliberately NOT here: it usually means a
 *  malformed *payload*, and pruning on it would wipe every official's tokens. */
const DEAD_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

export interface FcmChannelDeps {
  messaging: Pick<Messaging, 'sendEachForMulticast'>;
  /** Injected so tests don't need Firestore FieldValue sentinels. Production
   *  wiring (pipeline/wiring.ts) uses FieldValue.arrayRemove. */
  removeDeadTokens: (uid: string, tokens: string[]) => Promise<void>;
  logger: { warn: (obj: object, msg: string) => void };
}

function buildMessage(tokens: string[], msg: OutboundMessage): MulticastMessage {
  return {
    tokens,
    notification: { title: msg.title, body: msg.body },
    // FCM data values must be strings.
    data: { alertId: msg.alertId, severity: msg.severity, link: msg.deepLink },
    webpush: {
      headers: { Urgency: msg.severity === 'critical' ? 'high' : 'normal' },
      // FCM rejects the WHOLE multicast if this link isn't https, which a
      // local dashboard (http://localhost:5174) isn't. The link still
      // travels in `data` either way.
      ...(msg.deepLink.startsWith('https://') ? { fcmOptions: { link: msg.deepLink } } : {}),
    },
    android: { priority: msg.severity === 'critical' ? 'high' : 'normal' },
  };
}

export function createFcmChannel(deps: FcmChannelDeps): ChannelAdapter {
  return {
    channel: 'push',
    mode: 'live',

    async send(recipients: Recipient[], msg: OutboundMessage): Promise<DeliveryResult[]> {
      const results: DeliveryResult[] = [];

      // Flatten to (token -> owner) so one multicast can span many officials.
      const owners: Array<{ uid: string; token: string }> = [];
      for (const r of recipients) {
        if (!r.fcmTokens?.length) {
          // Recorded as failed on purpose: the dashboard should show that
          // this officer has no registered device, so someone fixes it.
          results.push({ channel: 'push', to: r.uid, status: 'failed', simulated: false, detail: 'no registered FCM token' });
          continue;
        }
        for (const token of r.fcmTokens) owners.push({ uid: r.uid, token });
      }

      const okByUid = new Map<string, boolean>();
      const deadByUid = new Map<string, string[]>();

      for (let i = 0; i < owners.length; i += FCM_MULTICAST_LIMIT) {
        const chunk = owners.slice(i, i + FCM_MULTICAST_LIMIT);
        const batch = await deps.messaging.sendEachForMulticast(buildMessage(chunk.map((o) => o.token), msg));
        batch.responses.forEach((resp, j) => {
          const { uid, token } = chunk[j]!;
          okByUid.set(uid, (okByUid.get(uid) ?? false) || resp.success);
          if (!resp.success && resp.error && DEAD_TOKEN_CODES.has(resp.error.code)) {
            deadByUid.set(uid, [...(deadByUid.get(uid) ?? []), token]);
          }
        });
      }

      // A user counts as reached if ANY of their devices accepted it. FCM
      // acceptance is 'sent', never 'delivered' -- we have no receipts.
      for (const [uid, ok] of okByUid) {
        results.push({ channel: 'push', to: uid, status: ok ? 'sent' : 'failed', simulated: false });
      }

      for (const [uid, tokens] of deadByUid) {
        try {
          await deps.removeDeadTokens(uid, tokens);
        } catch (error) {
          deps.logger.warn({ err: error, uid, count: tokens.length }, 'Failed to prune dead FCM tokens');
        }
      }
      return results;
    },
  };
}
