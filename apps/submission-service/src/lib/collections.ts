import { getDb } from '@vayusetu/gcp-clients';
import type { CollectionReference } from 'firebase-admin/firestore';
import type { AnalysisResult, Submission, User } from '@vayusetu/shared-types';

/**
 * A plain `as` cast, not a real `.withConverter()` -- these give
 * compile-time hints for what code written against a collection SHOULD
 * look like, not a runtime schema guarantee. Validated data goes in via
 * Zod at the API boundary (see routes/*.ts); this layer doesn't re-verify
 * shape on read. That's an intentional Week 1 simplification, not an
 * oversight -- worth revisiting with real `.withConverter()` calls once
 * more than one service writes to these collections.
 */
export function usersCollection(): CollectionReference<User> {
  return getDb().collection('users') as CollectionReference<User>;
}

export function submissionsCollection(): CollectionReference<Submission> {
  return getDb().collection('submissions') as CollectionReference<Submission>;
}

export function analysisResultsCollection(): CollectionReference<AnalysisResult> {
  return getDb().collection('analysisResults') as CollectionReference<AnalysisResult>;
}
