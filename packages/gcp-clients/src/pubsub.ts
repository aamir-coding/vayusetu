import { PubSub, type Topic } from '@google-cloud/pubsub';
import type { CorridorId, H3Index } from '@vayusetu/shared-types';
import { getProjectId } from './env.js';

let client: PubSub | undefined;

function getClient(): PubSub {
  if (!client) {
    client = new PubSub({ projectId: getProjectId() });
  }
  return client;
}

/**
 * API_CONTRACTS.md §4.3, verbatim: every payload is a thin reference (an
 * ID plus the minimum needed to route/filter), never the full entity --
 * the subscriber always re-reads current state rather than trusting a
 * potentially-stale event. Do not add fields here "for convenience"; that
 * is exactly the shortcut §4.3 forbids, and it's the one design rule in
 * this file every future publisher (analysis-service, hotspot-service,
 * forecast-service) needs to keep honoring too.
 *
 * `alert.created` is deliberately absent -- API_CONTRACTS.md marks its
 * subscriber as "(notification dispatch, in-process)", i.e. it never
 * crosses a Pub/Sub boundary, so it gets no topic here.
 */
export interface PubSubEventMap {
  'submission.created': { submissionId: string };
  'analysis.completed': { submissionId: string; h3Index: H3Index; corridorId: CorridorId };
  'hotspot.updated': { hotspotCellId: string; corridorId: CorridorId; hotspotConfidenceScore: number };
  'forecast.updated': { forecastRunId: string; corridorId: CorridorId; maxHorizonAQI: number };
}

export type PubSubTopicName = keyof PubSubEventMap;

export const PUBSUB_TOPICS: readonly PubSubTopicName[] = [
  'submission.created',
  'analysis.completed',
  'hotspot.updated',
  'forecast.updated',
];

export async function publishEvent<K extends PubSubTopicName>(
  topicName: K,
  payload: PubSubEventMap[K],
): Promise<string> {
  const topic: Topic = getClient().topic(topicName);
  const data = Buffer.from(JSON.stringify(payload));
  try {
    return await topic.publishMessage({ data });
  } catch (error) {
    throw new Error(
      `Failed to publish to Pub/Sub topic "${topicName}". If this is local dev, confirm ` +
        'PUBSUB_EMULATOR_HOST is set and the emulator is running with this topic created ' +
        '(pnpm emulator:topics in apps/submission-service). If this is a deployed ' +
        `environment, confirm Terraform has applied the "${topicName}" topic and this ` +
        `service's account has roles/pubsub.publisher. Original error: ${(error as Error).message}`,
    );
  }
}
