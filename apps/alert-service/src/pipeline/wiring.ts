import { FieldValue } from 'firebase-admin/firestore';
import { getAdminMessaging } from '@vayusetu/gcp-clients';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { usersCollection } from '../lib/collections.js';
import { jurisdictionResolver } from '../lib/geo.js';
import { type BriefingGenerator, templateBriefingGenerator } from '../domain/briefing.js';
import { createGeminiBriefingGenerator } from '../gemini/geminiBriefingGenerator.js';
import { createPipelineCModelCall } from '../gemini/modelCall.js';
import { parseHotspotThresholds } from '../domain/severity.js';
import { createFcmChannel } from '../notifications/fcmChannel.js';
import { createNotificationGateway, createStubChannel } from '../notifications/gateway.js';
import { findRecipients } from '../notifications/recipients.js';
import type { ChannelAdapter } from '../notifications/types.js';
import type { PipelineDeps } from './alertPipeline.js';

export function buildPipelineDeps(logger: FastifyBaseLogger): PipelineDeps {
  const adapters: Partial<Record<'push' | 'sms' | 'whatsapp', ChannelAdapter>> = {
    push:
      env.PUSH_CHANNEL_MODE === 'live'
        ? createFcmChannel({
            messaging: getAdminMessaging(),
            removeDeadTokens: async (uid, tokens) => {
              await usersCollection().doc(uid).update({ fcmTokens: FieldValue.arrayRemove(...tokens) });
            },
            logger,
          })
        : createStubChannel('push', logger),
  };
  if (env.SMS_CHANNEL_MODE === 'stub') adapters.sms = createStubChannel('sms', logger);
  if (env.WHATSAPP_CHANNEL_MODE === 'stub') adapters.whatsapp = createStubChannel('whatsapp', logger);

  const gateway = createNotificationGateway({ adapters, dashboardBaseUrl: env.DASHBOARD_BASE_URL, logger });

  const briefing: BriefingGenerator =
    env.BRIEFING_GENERATOR === 'gemini'
      ? createGeminiBriefingGenerator({
          callModel: createPipelineCModelCall(), // throws at boot until Engineer 3 lands it
          fallback: templateBriefingGenerator,
          timeoutMs: env.BRIEFING_TIMEOUT_MS,
          logger,
        })
      : templateBriefingGenerator;

  logger.info({ channels: gateway.describe(), briefing: briefing.name }, 'alert pipeline ready');

  return {
    briefing,
    gateway,
    resolveJurisdiction: (geo) => jurisdictionResolver.resolve(geo),
    findRecipients,
    hotspotThresholds: parseHotspotThresholds(env.HOTSPOT_SEVERITY_THRESHOLDS),
    suppressionWindowHours: env.SUPPRESSION_WINDOW_HOURS,
    fallbackStateCode: env.DEFAULT_STATE_CODE,
    now: () => new Date(),
    logger,
  };
}
