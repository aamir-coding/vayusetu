import type { Alert, NotificationChannel } from '@vayusetu/shared-types';
import {
  CHANNELS_BY_SEVERITY,
  type ChannelAdapter,
  type DeliveryResult,
  type OutboundMessage,
  type Recipient,
  toOutboundMessage,
} from './types.js';

function maskPhone(phone: string): string {
  return phone.length > 4 ? `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}` : '****';
}

/**
 * Stub behind the SAME ChannelAdapter interface as FCM. Used for the SMS and
 * WhatsApp partner gateway (not yet contracted -- Week 2 scope says "stubbed
 * behind the same interface"), and for push in local dev (no FCM emulator).
 * Results are marked simulated, so they're logged but never persisted.
 */
export function createStubChannel(
  channel: NotificationChannel,
  logger: { info: (obj: object, msg: string) => void },
): ChannelAdapter {
  return {
    channel,
    mode: 'stub',
    async send(recipients: Recipient[], msg: OutboundMessage): Promise<DeliveryResult[]> {
      const needsPhone = channel !== 'push';
      const results: DeliveryResult[] = [];
      for (const r of recipients) {
        if (needsPhone && !r.phoneNumber) continue;
        logger.info(
          { channel, to: r.uid, ...(needsPhone ? { phone: maskPhone(r.phoneNumber!) } : { tokens: r.fcmTokens.length }), alertId: msg.alertId },
          `[STUB ${channel}] ${msg.title}`,
        );
        results.push({ channel, to: r.uid, status: 'sent', simulated: true });
      }
      return results;
    },
  };
}

export interface NotificationGateway {
  dispatch(alert: Alert, recipients: Recipient[]): Promise<DeliveryResult[]>;
  describe(): Record<NotificationChannel, 'live' | 'stub' | 'disabled'>;
}

export function createNotificationGateway(args: {
  adapters: Partial<Record<NotificationChannel, ChannelAdapter>>;
  dashboardBaseUrl: string;
  logger: { error: (obj: object, msg: string) => void };
}): NotificationGateway {
  return {
    describe() {
      return {
        push: args.adapters.push?.mode ?? 'disabled',
        sms: args.adapters.sms?.mode ?? 'disabled',
        whatsapp: args.adapters.whatsapp?.mode ?? 'disabled',
      };
    },

    async dispatch(alert, recipients) {
      if (recipients.length === 0) return [];
      const msg = toOutboundMessage(alert, args.dashboardBaseUrl);
      const channels = CHANNELS_BY_SEVERITY[alert.severity];

      // Channels run in parallel and fail independently: an SMS-gateway
      // outage must never cost officials their push notification.
      const settled = await Promise.allSettled(
        channels.map(async (ch) => {
          const adapter = args.adapters[ch];
          return adapter ? adapter.send(recipients, msg) : [];
        }),
      );

      const results: DeliveryResult[] = [];
      settled.forEach((s, i) => {
        const channel = channels[i]!;
        if (s.status === 'fulfilled') {
          results.push(...s.value);
        } else {
          args.logger.error({ err: s.reason, channel, alertId: alert.id }, 'Notification channel failed');
          const simulated = args.adapters[channel]?.mode === 'stub';
          for (const r of recipients) results.push({ channel, to: r.uid, status: 'failed', simulated, detail: 'channel error' });
        }
      });
      return results;
    },
  };
}

/** What actually gets written to Alert.notificationsSent. */
export function toNotificationsSent(results: DeliveryResult[], at: string): Alert['notificationsSent'] {
  return results.filter((r) => !r.simulated).map((r) => ({ channel: r.channel, to: r.to, at, status: r.status }));
}
