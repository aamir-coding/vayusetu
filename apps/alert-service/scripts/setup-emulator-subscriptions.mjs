// Creates PUSH subscriptions in the Pub/Sub EMULATOR that deliver
// hotspot.updated / forecast.updated to a locally running alert-service --
// the local equivalent of infra/terraform pubsub.tf. The emulator sends no
// OIDC token, so run alert-service with PUBSUB_PUSH_AUTH=off.
//   PUBSUB_EMULATOR_HOST=localhost:8085 pnpm --filter @vayusetu/alert-service emulator:subscriptions
// Re-run after every emulator restart (it persists nothing).
import { PubSub } from '@google-cloud/pubsub';

if (!process.env.PUBSUB_EMULATOR_HOST) {
  console.error('PUBSUB_EMULATOR_HOST is not set -- this script only targets the emulator, never real GCP.');
  process.exit(1);
}
const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'vayusetu-ncr-dev';
const base = (process.env.ALERT_SERVICE_URL ?? 'http://localhost:8082').replace(/\/$/, '');
const pubsub = new PubSub({ projectId });

const ROUTES = [
  ['hotspot.updated', '/pubsub/hotspot-updated'],
  ['forecast.updated', '/pubsub/forecast-updated'],
];

for (const [topicName, path] of ROUTES) {
  const topic = pubsub.topic(topicName);
  if (!(await topic.exists())[0]) await pubsub.createTopic(topicName);
  const subName = `alert-service-${topicName.replace('.', '-')}`;
  const pushEndpoint = `${base}${path}`;
  const sub = topic.subscription(subName);
  if ((await sub.exists())[0]) {
    await sub.modifyPushConfig({ pushEndpoint });
    console.log(`  = ${subName} -> ${pushEndpoint} (updated)`);
  } else {
    await topic.createSubscription(subName, { pushConfig: { pushEndpoint }, ackDeadlineSeconds: 60 });
    console.log(`  + ${subName} -> ${pushEndpoint}`);
  }
}
