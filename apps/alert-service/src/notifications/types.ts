import type { Alert, AlertSeverity, NotificationChannel, User } from '@vayusetu/shared-types';

/** Everything a channel needs about a person -- nothing more. */
export type Recipient = Pick<User, 'uid' | 'role' | 'fcmTokens' | 'phoneNumber' | 'preferredLanguage'>;

export interface OutboundMessage {
  alertId: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  deepLink: string;
}

export interface DeliveryResult {
  channel: NotificationChannel;
  /** Recipient uid -- never a phone number or token. Alert docs are read by
   *  every official in the jurisdiction; don't spread PII into them. */
  to: string;
  status: 'sent' | 'failed';
  /** true => a stub produced this; it's logged but NOT persisted to
   *  Alert.notificationsSent, so the audit trail never claims an SMS went
   *  out when none did. */
  simulated: boolean;
  detail?: string;
}

/**
 * The channel abstraction. FCM, the SMS stub and the WhatsApp stub all
 * implement exactly this; when the real partner gateway is contracted, it
 * becomes one more implementation and nothing upstream changes.
 */
export interface ChannelAdapter {
  readonly channel: NotificationChannel;
  readonly mode: 'live' | 'stub';
  send(recipients: Recipient[], message: OutboundMessage): Promise<DeliveryResult[]>;
}

/**
 * Which channels fire at which severity. Product decision, not in any
 * contract doc -- flagged in WEEK2_SETUP.md. Rationale: push reaches the
 * dashboard; SMS/WhatsApp are for "officers without the dashboard open"
 * (ARCHITECTURE_OVERVIEW.md), so they're reserved for alerts worth
 * interrupting someone for.
 */
export const CHANNELS_BY_SEVERITY: Record<AlertSeverity, readonly NotificationChannel[]> = {
  info: [],
  watch: ['push'],
  warning: ['push', 'sms'],
  critical: ['push', 'sms', 'whatsapp'],
};

export function toOutboundMessage(alert: Alert, dashboardBaseUrl: string): OutboundMessage {
  return {
    alertId: alert.id,
    severity: alert.severity,
    title: `[${alert.severity.toUpperCase()}] ${alert.title}`,
    body: alert.recommendedActions[0] ? `${alert.description.split('. ')[0]}. Action: ${alert.recommendedActions[0]}` : alert.description,
    deepLink: `${dashboardBaseUrl.replace(/\/$/, '')}/alerts/${encodeURIComponent(alert.id)}`,
  };
}
