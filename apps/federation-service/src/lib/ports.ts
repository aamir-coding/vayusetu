import type { FederatedModel } from '@vayusetu/shared-types';
import type { Contribution, HotspotObservation, HotspotSummaryRow } from './kAnonymize.js';

export type ModelType = FederatedModel['modelType'];
export const MODEL_TYPES: readonly ModelType[] = ['hotspot', 'forecast'];

/** This state's own data, read inside its own project. */
export interface LocalDataSource {
  hotspotObservations(startUtc: Date, endUtc: Date): Promise<HotspotObservation[]>;
  contributions(startUtc: Date, endUtc: Date): Promise<Contribution[]>;
}

/** The current local model of a type, as Engineer 3 registered it. */
export interface LocalModelInfo {
  modelType: ModelType;
  /** projects/<p>/locations/<l>/models/<id>@<versionId> */
  resourceName: string;
  version: string;
  featureSchemaVersion: string;
  trainingDataSummary: FederatedModel['trainingDataSummary'];
  performanceMetrics: Record<string, number>;
}

export interface ModelRegistry {
  /** Default-alias version of the local model of this type, or null if none. */
  localDefaultModel(type: ModelType): Promise<LocalModelInfo | null>;
  /** Cross-project copy INTO the exchange registry; returns the exchange resource name. */
  copyToExchange(model: LocalModelInfo, exchangeModelId: string): Promise<string>;
  /** Cross-project copy FROM the exchange INTO this project; returns the local resource name. */
  importFromExchange(exchangeResourceName: string, localModelId: string): Promise<string>;
}

/**
 * Catalog row in <exchange>.federation_exchange.shared_models -- PROPOSED DDL
 * (not in DB_SCHEMA.md yet; see WEEK3_SETUP.md). Needed because Model
 * Registry copies drop evaluations, so metrics must travel in our catalog.
 */
export interface SharedModelRecord {
  model_id: string;
  source_state_code: string;
  model_type: ModelType;
  version: string;
  feature_schema_version: string;
  vertex_model_registry_uri: string;
  training_record_count: number;
  training_date_range_start: string;
  training_date_range_end: string;
  performance_metrics: Record<string, number>;
  shared_at: string;
}

/** The National Exchange (a separate GCP project). */
export interface ExchangeStore {
  /** Atomically replaces this deployment's rows for that week (idempotent reruns). */
  publishHotspotSummary(rows: HotspotSummaryRow[], weekStartDate: string, ownedStates: string[]): Promise<void>;
  hotspotSummarySince(weekStartDate: string): Promise<HotspotSummaryRow[]>;
  getSharedModel(modelId: string): Promise<(SharedModelRecord & { download_count: number }) | null>;
  listSharedModels(): Promise<Array<SharedModelRecord & { download_count: number }>>;
  insertSharedModel(record: SharedModelRecord): Promise<void>;
  recordImport(modelId: string, importingStateCode: string, at: string): Promise<void>;
}

export interface ActiveModel {
  modelId: string;
  localVertexModel: string;
  activatedAt: string;
  activatedBy: string;
}

/** Firestore federationExchange/{stateCode} (+ sharedModels sub-collection). */
export interface FederationStateStore {
  mirrorSharedModels(models: Array<FederatedModel & { featureSchemaVersion: string }>): Promise<number>;
  listMirroredModels(type?: ModelType): Promise<Array<FederatedModel & { featureSchemaVersion: string }>>;
  getActive(type: ModelType): Promise<ActiveModel | null>;
  setActive(type: ModelType, active: ActiveModel): Promise<void>;
}

/** Stable, registry-safe id: [a-z0-9_-], <= 63 chars, starts with a letter. */
export function exchangeModelId(state: string, type: ModelType, version: string): string {
  const slug = `${state}-${type}-${version}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-');
  return (/^[a-z]/.test(slug) ? slug : `m-${slug}`).slice(0, 63).replace(/-$/, '');
}

export function toFederatedModel(r: SharedModelRecord & { download_count: number }): FederatedModel & { featureSchemaVersion: string } {
  return {
    id: r.model_id,
    sourceStateCode: r.source_state_code,
    modelType: r.model_type,
    vertexModelRegistryUri: r.vertex_model_registry_uri,
    version: r.version,
    trainingDataSummary: {
      recordCount: r.training_record_count,
      dateRangeStart: r.training_date_range_start,
      dateRangeEnd: r.training_date_range_end,
    },
    performanceMetrics: r.performance_metrics,
    sharedAt: r.shared_at,
    downloadCount: r.download_count,
    featureSchemaVersion: r.feature_schema_version,
  };
}

/** Strip internal fields before a model leaves the API. */
export function publicModel(m: FederatedModel & { featureSchemaVersion?: string }): FederatedModel {
  const copy: FederatedModel & { featureSchemaVersion?: string } = { ...m };
  delete copy.featureSchemaVersion;
  return copy;
}
