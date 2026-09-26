import type { FederatedModel } from '@vayusetu/shared-types';
import type { Contribution, HotspotObservation, HotspotSummaryRow } from '../src/lib/kAnonymize.js';
import type {
  ActiveModel,
  ExchangeStore,
  FederationStateStore,
  LocalDataSource,
  LocalModelInfo,
  ModelRegistry,
  ModelType,
  SharedModelRecord,
} from '../src/lib/ports.js';

/** The National Exchange, in memory. Mirrors the MERGE semantics of the real adapter. */
export class FakeExchange implements ExchangeStore {
  summary: HotspotSummaryRow[] = [];
  models = new Map<string, SharedModelRecord>();
  imports: Array<{ modelId: string; state: string; at: string }> = [];
  failNext: Partial<Record<keyof ExchangeStore, Error>> = {};

  private maybeFail(op: keyof ExchangeStore) {
    const e = this.failNext[op];
    if (e) {
      delete this.failNext[op];
      throw e;
    }
  }
  async publishHotspotSummary(rows: HotspotSummaryRow[], week: string, owned: string[]) {
    this.maybeFail('publishHotspotSummary');
    const key = (r: HotspotSummaryRow) => `${r.source_state_code}|${r.h3_index_generalized}|${r.week_start_date}`;
    const incoming = new Map(rows.map((r) => [key(r), r]));
    this.summary = this.summary
      .filter((r) => !(r.week_start_date === week && owned.includes(r.source_state_code) && !incoming.has(key(r))))
      .map((r) => incoming.get(key(r)) ?? r);
    for (const [k, r] of incoming) if (!this.summary.some((x) => key(x) === k)) this.summary.push(r);
  }
  async hotspotSummarySince(week: string) {
    return this.summary.filter((r) => r.week_start_date >= week);
  }
  private withCount(r: SharedModelRecord) {
    return { ...r, download_count: this.imports.filter((i) => i.modelId === r.model_id).length };
  }
  async getSharedModel(id: string) {
    this.maybeFail('getSharedModel');
    const r = this.models.get(id);
    return r ? this.withCount(r) : null;
  }
  async listSharedModels() {
    this.maybeFail('listSharedModels');
    return [...this.models.values()].map((r) => this.withCount(r));
  }
  async insertSharedModel(r: SharedModelRecord) {
    this.maybeFail('insertSharedModel');
    if (!this.models.has(r.model_id)) this.models.set(r.model_id, r);
  }
  async recordImport(modelId: string, state: string, at: string) {
    this.maybeFail('recordImport');
    this.imports.push({ modelId, state, at });
  }
}

export class FakeRegistry implements ModelRegistry {
  local: Partial<Record<ModelType, LocalModelInfo>> = {};
  exchangeCopies: string[] = [];
  localImports: string[] = [];
  failNext?: Error;
  importDelayMs = 0;

  async localDefaultModel(type: ModelType) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    return this.local[type] ?? null;
  }
  async copyToExchange(_m: LocalModelInfo, id: string) {
    this.exchangeCopies.push(id);
    return `projects/exchange/locations/asia-south1/models/${id}`;
  }
  async importFromExchange(uri: string, localId: string) {
    if (this.importDelayMs) await new Promise((r) => setTimeout(r, this.importDelayMs));
    this.localImports.push(uri);
    return `projects/local/locations/asia-south1/models/${localId}@1`;
  }
}

export class FakeState implements FederationStateStore {
  mirror = new Map<string, FederatedModel & { featureSchemaVersion: string }>();
  active: Partial<Record<ModelType, ActiveModel>> = {};
  async mirrorSharedModels(models: Array<FederatedModel & { featureSchemaVersion: string }>) {
    for (const m of models) this.mirror.set(m.id, m);
    return models.length;
  }
  async listMirroredModels(type?: ModelType) {
    return [...this.mirror.values()].filter((m) => !type || m.modelType === type).sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
  }
  async getActive(type: ModelType) {
    return this.active[type] ?? null;
  }
  async setActive(type: ModelType, a: ActiveModel) {
    this.active[type] = a;
  }
}

export class FakeLocal implements LocalDataSource {
  observations: HotspotObservation[] = [];
  contributionList: Contribution[] = [];
  lastRange?: { start: Date; end: Date };
  async hotspotObservations(start: Date, end: Date) {
    this.lastRange = { start, end };
    return this.observations;
  }
  async contributions() {
    return this.contributionList;
  }
}

export function sharedModel(over: Partial<SharedModelRecord> = {}): SharedModelRecord {
  return {
    model_id: 'hr-hotspot-v3',
    source_state_code: 'HR',
    model_type: 'hotspot',
    version: 'v3',
    feature_schema_version: 'hs-v1',
    vertex_model_registry_uri: 'projects/exchange/locations/asia-south1/models/hr-hotspot-v3',
    training_record_count: 48210,
    training_date_range_start: '2026-06-01T00:00:00Z',
    training_date_range_end: '2026-08-31T00:00:00Z',
    performance_metrics: { auPrc: 0.81 },
    shared_at: '2026-09-20T01:00:00Z',
    ...over,
  };
}
