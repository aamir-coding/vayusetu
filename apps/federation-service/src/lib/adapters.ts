import type { Firestore } from 'firebase-admin/firestore';
import type { Query } from '@google-cloud/bigquery';
import type { FederatedModel } from '@vayusetu/shared-types';
import type { Contribution, HotspotObservation, HotspotSummaryRow } from './kAnonymize.js';
import type {
  ActiveModel,
  ExchangeStore,
  FederationStateStore,
  LocalDataSource,
  LocalModelInfo,
  ModelRegistry,
  ModelType,
  SharedModelRecord,
} from './ports.js';

// ============================================================ Firestore (state project)

export function createFirestoreAdapters(db: Firestore, stateCode: string): LocalDataSource & FederationStateStore {
  const root = () => db.collection('federationExchange').doc(stateCode);
  const mirror = () => db.collection(`federationExchange/${stateCode}/sharedModels`);

  return {
    /**
     * NOTE: Firestore `hotspots` holds only the TOP cells hotspot-service pushes
     * (ARCHITECTURE_OVERVIEW: full grid -> BigQuery). Averages are therefore
     * biased toward hot cells. Swap to the BigQuery grid once Engineer 3's
     * table name is in DB_SCHEMA.md -- flagged in WEEK3_SETUP.md.
     */
    async hotspotObservations(startUtc, endUtc): Promise<HotspotObservation[]> {
      const snap = await db
        .collection('hotspots')
        .where('timestampHour', '>=', startUtc.toISOString())
        .where('timestampHour', '<', endUtc.toISOString())
        .get();
      return snap.docs.flatMap((d) => {
        const v = d.data() as { h3Index?: unknown; hotspotConfidenceScore?: unknown; modelVersion?: unknown };
        return typeof v.h3Index === 'string' && typeof v.hotspotConfidenceScore === 'number'
          ? [{
              h3Index: v.h3Index,
              hotspotConfidenceScore: v.hotspotConfidenceScore,
              ...(typeof v.modelVersion === 'string' ? { modelVersion: v.modelVersion } : {}),
            }]
          : [];
      });
    },

    async contributions(startUtc, endUtc): Promise<Contribution[]> {
      const snap = await db
        .collection('submissions')
        .where('uploadedAt', '>=', startUtc.toISOString())
        .where('uploadedAt', '<', endUtc.toISOString())
        .get();
      return snap.docs.flatMap((d) => {
        const v = d.data() as { h3Index?: string; userId?: string; status?: string; jurisdiction?: { stateCode?: string } };
        // Failed uploads never became real reports.
        if (!v.h3Index || !v.userId || !v.jurisdiction?.stateCode || v.status === 'failed') return [];
        return [{ h3Index: v.h3Index, userId: v.userId, stateCode: v.jurisdiction.stateCode }];
      });
    },

    async mirrorSharedModels(models) {
      const at = new Date().toISOString();
      await Promise.all(models.map((m) => mirror().doc(m.id).set({ ...m, mirroredAt: at })));
      return models.length;
    },

    async listMirroredModels(type?: ModelType) {
      const snap = await mirror().get();
      return snap.docs
        .map((d) => {
          const m = { ...(d.data() as FederatedModel & { featureSchemaVersion: string; mirroredAt?: string }) };
          delete m.mirroredAt;
          return m;
        })
        .filter((m) => !type || m.modelType === type)
        .sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
    },

    async getActive(type) {
      const snap = await root().get();
      const active = (snap.data() as { activeModels?: Partial<Record<ModelType, ActiveModel>> } | undefined)?.activeModels;
      return active?.[type] ?? null;
    },

    /** Read-modify-write in a transaction: a shallow merge would clobber the
     *  other model type's pointer, and two concurrent imports must serialize. */
    async setActive(type, active) {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(root());
        const current = (snap.data() as { activeModels?: Record<string, ActiveModel> } | undefined)?.activeModels ?? {};
        tx.set(root(), { activeModels: { ...current, [type]: active } }, { merge: true });
      });
    },
  };
}

// ============================================================ BigQuery (exchange project)

/** Typed with the SDK's own `Query` options (tsc caught a hand-written
 *  shape that the real client didn't accept -- see wiring.ts). */
export interface BigQueryLike {
  query(options: Query): Promise<[unknown[], ...unknown[]]>;
}

const SUMMARY_TYPES = {
  source_state_code: 'STRING', h3_index_generalized: 'STRING', week_start_date: 'STRING',
  avg_hotspot_confidence: 'FLOAT64', underlying_report_count_bucket: 'STRING', model_version: 'STRING', shared_at: 'STRING',
};

export function createBigQueryExchange(bq: BigQueryLike, cfg: { project: string; dataset: string; location: string }): ExchangeStore {
  const t = (table: string) => `\`${cfg.project}.${cfg.dataset}.${table}\``;
  const run = async (query: string, params?: Record<string, unknown>, types?: Record<string, unknown>) =>
    (await bq.query({ query, params, types: types as Query['types'], location: cfg.location }))[0] as Array<Record<string, unknown>>;

  const modelSelect = `
    SELECT m.model_id, m.source_state_code, m.model_type, m.version, m.feature_schema_version,
           m.vertex_model_registry_uri, m.training_record_count,
           FORMAT_TIMESTAMP('%FT%TZ', m.training_date_range_start) AS training_date_range_start,
           FORMAT_TIMESTAMP('%FT%TZ', m.training_date_range_end)   AS training_date_range_end,
           m.performance_metrics,
           FORMAT_TIMESTAMP('%FT%TZ', m.shared_at) AS shared_at,
           (SELECT COUNT(*) FROM ${t('model_imports')} i WHERE i.model_id = m.model_id) AS download_count
    FROM ${t('shared_models')} m`;
  const toRecord = (r: Record<string, unknown>) => ({
    ...(r as unknown as SharedModelRecord),
    training_record_count: Number(r.training_record_count ?? 0),
    performance_metrics: JSON.parse(String(r.performance_metrics ?? '{}')) as Record<string, number>,
    download_count: Number(r.download_count ?? 0),
  });

  return {
    /**
     * One MERGE = one atomic statement: upserts this week's rows AND deletes
     * rows this deployment published for the same week that no longer qualify
     * -- so nightly reruns are idempotent and never duplicate. Scoped to
     * `ownedStates` so it can never touch another state's rows.
     */
    async publishHotspotSummary(rows: HotspotSummaryRow[], weekStartDate: string, ownedStates: string[]) {
      await run(
        `MERGE ${t('hotspot_summary')} T
         USING (
           SELECT r.source_state_code, r.h3_index_generalized, DATE(r.week_start_date) AS week_start_date,
                  r.avg_hotspot_confidence, r.underlying_report_count_bucket, r.model_version,
                  TIMESTAMP(r.shared_at) AS shared_at
           FROM UNNEST(@rows) r
         ) S
         ON T.source_state_code = S.source_state_code
            AND T.h3_index_generalized = S.h3_index_generalized
            AND T.week_start_date = S.week_start_date
         WHEN MATCHED THEN UPDATE SET
            avg_hotspot_confidence = S.avg_hotspot_confidence,
            underlying_report_count_bucket = S.underlying_report_count_bucket,
            model_version = S.model_version, shared_at = S.shared_at
         WHEN NOT MATCHED BY TARGET THEN INSERT ROW
         WHEN NOT MATCHED BY SOURCE
            AND T.week_start_date = DATE(@week) AND T.source_state_code IN UNNEST(@states) THEN DELETE`,
        { rows, week: weekStartDate, states: ownedStates },
        { rows: [SUMMARY_TYPES], week: 'STRING', states: ['STRING'] },
      );
    },

    async hotspotSummarySince(weekStartDate) {
      const rows = await run(
        `SELECT source_state_code, h3_index_generalized, FORMAT_DATE('%F', week_start_date) AS week_start_date,
                avg_hotspot_confidence, underlying_report_count_bucket, model_version,
                FORMAT_TIMESTAMP('%FT%TZ', shared_at) AS shared_at
         FROM ${t('hotspot_summary')}
         WHERE week_start_date >= DATE(@since)`,
        { since: weekStartDate },
      );
      return rows as unknown as HotspotSummaryRow[];
    },

    async getSharedModel(modelId) {
      const rows = await run(`${modelSelect} WHERE m.model_id = @id`, { id: modelId });
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async listSharedModels() {
      return (await run(modelSelect)).map(toRecord);
    },

    /** MERGE on model_id: republishing the same version is a no-op. */
    async insertSharedModel(r: SharedModelRecord) {
      await run(
        `MERGE ${t('shared_models')} T
         USING (SELECT @model_id AS model_id) S ON T.model_id = S.model_id
         WHEN NOT MATCHED THEN INSERT (model_id, source_state_code, model_type, version, feature_schema_version,
           vertex_model_registry_uri, training_record_count, training_date_range_start, training_date_range_end,
           performance_metrics, shared_at)
         VALUES (@model_id, @source_state_code, @model_type, @version, @feature_schema_version,
           @vertex_model_registry_uri, @training_record_count, TIMESTAMP(@training_date_range_start),
           TIMESTAMP(@training_date_range_end), @performance_metrics, TIMESTAMP(@shared_at))`,
        { ...r, performance_metrics: JSON.stringify(r.performance_metrics) },
      );
    },

    async recordImport(modelId, importingStateCode, at) {
      await run(
        `INSERT INTO ${t('model_imports')} (model_id, importing_state_code, imported_at)
         VALUES (@id, @state, TIMESTAMP(@at))`,
        { id: modelId, state: importingStateCode, at },
      );
    },
  };
}

// ============================================================ Vertex AI Model Registry

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 6 || code === 'ALREADY_EXISTS';
}

type ProtoValue = {
  numberValue?: number | null;
  structValue?: { fields?: Record<string, ProtoValue> | null } | null;
};

/** Evaluation metrics arrive as a protobuf Value tree; flatten numeric leaves. */
export function flattenMetrics(v: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (typeof v === 'number' && Number.isFinite(v)) {
    out[prefix] = v;
  } else if (v && typeof v === 'object') {
    const pv = v as ProtoValue;
    if (typeof pv.numberValue === 'number') out[prefix] = pv.numberValue;
    else if (pv.structValue?.fields) {
      for (const [k, child] of Object.entries(pv.structValue.fields)) flattenMetrics(child, prefix ? `${prefix}.${k}` : k, out);
    } else if (!('structValue' in pv) && !('numberValue' in pv)) {
      for (const [k, child] of Object.entries(v)) flattenMetrics(child, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

export interface VertexModelClientLike {
  listModels(req: { parent: string; filter?: string }): Promise<[Array<{ name?: string | null }>, ...unknown[]]>;
  getModel(req: { name: string }): Promise<[
    { name?: string | null; versionId?: string | null; labels?: Record<string, string> | null; versionCreateTime?: unknown },
    ...unknown[],
  ]>;
  listModelEvaluations(req: { parent: string }): Promise<[Array<{ metrics?: unknown }>, ...unknown[]]>;
  copyModel(req: { parent: string; sourceModel: string; modelId?: string }): Promise<[
    { promise(): Promise<[{ model?: string | null; modelVersionId?: string | null }, ...unknown[]]> },
    ...unknown[],
  ]>;
}

/**
 * PROPOSED LABEL CONVENTION for Engineer 3 (flagged in WEEK3_SETUP.md), set on
 * each registered model version:
 *   vayusetu-model-type=hotspot|forecast   vayusetu-feature-schema=<e.g. hs-v1>
 *   vayusetu-train-rows=<int>              vayusetu-train-start / -end=<yyyy-mm-dd>
 * Metrics are read from the version's ModelEvaluations (AutoML writes them).
 *
 * Cross-project copy (Model Registry "copy model"): the DESTINATION project's
 * Vertex AI service agent must hold model-export permission on the SOURCE
 * project -- Terraform (Week 3 part 2) grants this in both directions.
 */
export function createVertexRegistry(
  client: VertexModelClientLike,
  cfg: { localProject: string; exchangeProject: string; location: string },
): ModelRegistry {
  const parentOf = (project: string) => `projects/${project}/locations/${cfg.location}`;

  return {
    async localDefaultModel(type) {
      const [models] = await client.listModels({
        parent: parentOf(cfg.localProject),
        filter: `labels.vayusetu-model-type="${type}"`,
      });
      const name = models[0]?.name;
      if (!name) return null;
      const [model] = await client.getModel({ name }); // resolves the 'default' alias version
      const labels = model.labels ?? {};
      const [evals] = await client.listModelEvaluations({ parent: `${name}@${model.versionId}` });
      return {
        modelType: type,
        resourceName: `${name}@${model.versionId}`,
        version: `v${model.versionId}`,
        featureSchemaVersion: labels['vayusetu-feature-schema'] ?? 'unspecified',
        trainingDataSummary: {
          recordCount: Number(labels['vayusetu-train-rows'] ?? 0),
          dateRangeStart: labels['vayusetu-train-start'] ? `${labels['vayusetu-train-start']}T00:00:00Z` : '1970-01-01T00:00:00Z',
          dateRangeEnd: labels['vayusetu-train-end'] ? `${labels['vayusetu-train-end']}T00:00:00Z` : '1970-01-01T00:00:00Z',
        },
        performanceMetrics: evals[0] ? flattenMetrics(evals[0].metrics) : {},
      } satisfies LocalModelInfo;
    },

    async copyToExchange(model, exchangeModelId) {
      let res: { model?: string | null };
      try {
        const [op] = await client.copyModel({
          parent: parentOf(cfg.exchangeProject),
          sourceModel: model.resourceName,
          modelId: exchangeModelId,
        });
        [res] = await op.promise();
      } catch (error) {
        // Resumable: a previous night copied it but died before cataloguing.
        if (isAlreadyExists(error)) return `${parentOf(cfg.exchangeProject)}/models/${exchangeModelId}`;
        throw error;
      }
      if (!res.model) throw new Error(`copyModel to exchange returned no model for ${model.resourceName}`);
      return res.model;
    },

    async importFromExchange(exchangeResourceName, localModelId) {
      let res: { model?: string | null; modelVersionId?: string | null };
      try {
        const [op] = await client.copyModel({
          parent: parentOf(cfg.localProject),
          sourceModel: exchangeResourceName,
          modelId: localModelId,
        });
        [res] = await op.promise();
      } catch (error) {
        // Retry after a timed-out request: the first copy completed server-side.
        if (isAlreadyExists(error)) return `${parentOf(cfg.localProject)}/models/${localModelId}`;
        throw error;
      }
      if (!res.model) throw new Error(`copyModel from exchange returned no model for ${exchangeResourceName}`);
      return res.modelVersionId ? `${res.model}@${res.modelVersionId}` : res.model;
    },
  };
}
