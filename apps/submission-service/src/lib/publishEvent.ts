import { publishEvent as publishToTopic } from '@vayusetu/gcp-clients';

/**
 * submission-service only ever publishes one event -- everything else in
 * `PubSubEventMap` (@vayusetu/gcp-clients) belongs to a different
 * publisher (see API_CONTRACTS.md §4.3). This wrapper exists, rather than
 * importing `@vayusetu/gcp-clients` directly in routes/submissions.ts, so
 * every call site in this service goes through one place if retry/outbox
 * behavior gets added later.
 */
export async function publishSubmissionCreated(submissionId: string): Promise<void> {
  await publishToTopic('submission.created', { submissionId });
}
