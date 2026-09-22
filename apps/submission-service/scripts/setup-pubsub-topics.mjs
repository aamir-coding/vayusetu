// Run this once after starting the Pub/Sub emulator (infra/scripts/dev-emulators.sh)
// -- the emulator doesn't persist anything between restarts, so topics
// need re-creating each time you start it fresh.
//   PUBSUB_EMULATOR_HOST=localhost:8085 pnpm emulator:topics
import { PubSub } from '@google-cloud/pubsub';

const TOPICS = ['submission.created', 'analysis.completed', 'hotspot.updated', 'forecast.updated'];

async function main() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'vayusetu-ncr-dev';
  if (!process.env.PUBSUB_EMULATOR_HOST) {
    console.error('PUBSUB_EMULATOR_HOST is not set -- this script only targets the emulator, never real GCP.');
    process.exit(1);
  }
  const pubsub = new PubSub({ projectId });
  console.log(`Creating Pub/Sub topics against ${process.env.PUBSUB_EMULATOR_HOST} (project=${projectId})`);
  for (const name of TOPICS) {
    const topic = pubsub.topic(name);
    const [exists] = await topic.exists();
    if (exists) {
      console.log(`  = ${name} (already exists)`);
    } else {
      await pubsub.createTopic(name);
      console.log(`  + ${name}`);
    }

    const subscriptionName = `${name}-debug-pull`;
    const subscription = pubsub.subscription(subscriptionName);
    const [subscriptionExists] = await subscription.exists();
    if (subscriptionExists) {
      console.log(`  = ${subscriptionName} (already exists)`);
    } else {
      await topic.createSubscription(subscriptionName);
      console.log(`  + ${subscriptionName}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
