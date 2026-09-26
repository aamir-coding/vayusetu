import { BigQuery } from '@google-cloud/bigquery';
import { v1 } from '@google-cloud/aiplatform';
import { getDb } from '@vayusetu/gcp-clients';
import { env } from './config/env.js';
import { createBigQueryExchange, createFirestoreAdapters, createVertexRegistry } from './lib/adapters.js';

/**
 * Real adapters. Passing the actual SDK clients into the adapters' minimal
 * interfaces makes `tsc` prove the SDKs satisfy them (method names, request
 * and response shapes) -- the only compile-time check available without GCP.
 */
export function buildProductionAdapters() {
  const firestore = createFirestoreAdapters(getDb(), env.FEDERATION_STATE_CODE);
  // Jobs run (and bill) in THIS state project; the tables live in the exchange project.
  const exchange = createBigQueryExchange(new BigQuery({ projectId: env.GOOGLE_CLOUD_PROJECT }), {
    project: env.EXCHANGE_PROJECT_ID,
    dataset: env.EXCHANGE_DATASET,
    location: env.BIGQUERY_LOCATION,
  });
  const registry = createVertexRegistry(
    new v1.ModelServiceClient({ apiEndpoint: `${env.VERTEX_LOCATION}-aiplatform.googleapis.com` }),
    { localProject: env.GOOGLE_CLOUD_PROJECT, exchangeProject: env.EXCHANGE_PROJECT_ID, location: env.VERTEX_LOCATION },
  );
  return { local: firestore, state: firestore, exchange, registry };
}
