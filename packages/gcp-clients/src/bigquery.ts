import { BigQuery } from '@google-cloud/bigquery';
import { getProjectId } from './env.js';

let client: BigQuery | undefined;

/**
 * Not used by any Week 1 service -- submission-service only touches
 * Firestore + Pub/Sub. This exists so hotspot-service, forecast-service,
 * and ingestion-jobs (Engineer 3 / Engineer 4, Week 2+) share one client
 * construction instead of each hand-rolling project/credential wiring.
 * Table DDL and dataset ownership live in docs/context/04_DB_SCHEMA.md
 * (Engineer 4, BigQuery steward) -- this file only builds the client.
 */
export function getBigQuery(): BigQuery {
  if (!client) {
    client = new BigQuery({ projectId: getProjectId() });
  }
  return client;
}

export const BQ_DATASET = 'core';
export const BQ_FEDERATION_DATASET = 'federation_exchange';
