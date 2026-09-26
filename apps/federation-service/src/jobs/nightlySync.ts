import { pathToFileURL } from 'node:url';
import { type KAnonymityOptions, kAnonymizeWeek, lastCompleteWeekIst } from '../lib/kAnonymize.js';
import {
  type ExchangeStore,
  type FederationStateStore,
  type LocalDataSource,
  MODEL_TYPES,
  type ModelRegistry,
  exchangeModelId,
  toFederatedModel,
} from '../lib/ports.js';

export interface SyncDeps {
  local: LocalDataSource;
  state: FederationStateStore;
  exchange: ExchangeStore;
  registry: ModelRegistry;
  cfg: { stateCode: string; ownedStates: string[]; k: KAnonymityOptions };
  now: () => Date;
  logger: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

export interface SyncReport {
  weekStartDate: string;
  summaryRowsPublished: number;
  suppressed: Record<string, number>;
  modelsPublished: string[];
  modelsMirrored: number;
  errors: string[];
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/**
 * Three INDEPENDENT steps -- one failing never blocks the others (a Vertex
 * outage shouldn't stop the week's k-anonymized summary). Any failure is
 * collected and makes the job exit non-zero, so Cloud Run Jobs marks the
 * execution failed and retries, and it is visible in monitoring.
 * Every step is idempotent, so retries and daily reruns are safe.
 */
export async function runNightlySync(deps: SyncDeps): Promise<SyncReport> {
  const { weekStartDate, startUtc, endUtc } = lastCompleteWeekIst(deps.now());
  const report: SyncReport = { weekStartDate, summaryRowsPublished: 0, suppressed: {}, modelsPublished: [], modelsMirrored: 0, errors: [] };
  const fail = (step: string, error: unknown) => {
    report.errors.push(`${step}: ${(error as Error).message}`);
    deps.logger.error({ err: error, step }, 'federation sync step failed');
  };

  // 1. EXPORT: k-anonymized, coarsened hotspot summary for the last complete week.
  try {
    const [observations, contributions] = await Promise.all([
      deps.local.hotspotObservations(startUtc, endUtc),
      deps.local.contributions(startUtc, endUtc),
    ]);
    const modelVersion = mostCommon(observations.flatMap((o) => (o.modelVersion ? [o.modelVersion] : []))) ?? 'unknown';
    const { rows, suppressed } = kAnonymizeWeek({
      observations, contributions, weekStartDate, modelVersion,
      sharedAt: deps.now().toISOString(), options: deps.cfg.k,
    });
    // Defense in depth: never publish a row for a state this deployment doesn't own.
    const publishable = rows.filter((r) => deps.cfg.ownedStates.includes(r.source_state_code));
    await deps.exchange.publishHotspotSummary(publishable, weekStartDate, deps.cfg.ownedStates);
    report.summaryRowsPublished = publishable.length;
    report.suppressed = { ...suppressed, notOwnedState: rows.length - publishable.length };
  } catch (error) {
    fail('export-summary', error);
  }

  // 2. EXPORT: this state's current models -> exchange registry + catalog.
  for (const type of MODEL_TYPES) {
    try {
      const local = await deps.registry.localDefaultModel(type);
      if (!local) continue; // Engineer 3 hasn't registered one yet
      const id = exchangeModelId(deps.cfg.stateCode, type, local.version);
      if (await deps.exchange.getSharedModel(id)) continue; // already shared
      const uri = await deps.registry.copyToExchange(local, id);
      await deps.exchange.insertSharedModel({
        model_id: id,
        source_state_code: deps.cfg.stateCode,
        model_type: type,
        version: local.version,
        feature_schema_version: local.featureSchemaVersion,
        vertex_model_registry_uri: uri,
        training_record_count: local.trainingDataSummary.recordCount,
        training_date_range_start: local.trainingDataSummary.dateRangeStart,
        training_date_range_end: local.trainingDataSummary.dateRangeEnd,
        performance_metrics: local.performanceMetrics,
        shared_at: deps.now().toISOString(),
      });
      report.modelsPublished.push(id);
    } catch (error) {
      fail(`export-model:${type}`, error);
    }
  }

  // 3. PULL: mirror the whole catalog into Firestore for the dashboard/API.
  try {
    const catalog = await deps.exchange.listSharedModels();
    report.modelsMirrored = await deps.state.mirrorSharedModels(catalog.map(toFederatedModel));
  } catch (error) {
    fail('pull-catalog', error);
  }

  deps.logger.info({ report }, 'federation nightly sync finished');
  return report;
}

// ---------------------------------------------------------- Cloud Run Job entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { buildProductionAdapters } = await import('../wiring.js');
  const { env } = await import('../config/env.js');
  const { default: pino } = await import('pino');
  const logger = pino({ level: 'info' });
  const adapters = buildProductionAdapters();
  const report = await runNightlySync({
    ...adapters,
    cfg: {
      stateCode: env.FEDERATION_STATE_CODE,
      ownedStates: env.FEDERATION_OWNED_STATES,
      k: { minContributors: env.K_MIN_CONTRIBUTORS, minReports: env.K_MIN_REPORTS, generalizedResolution: env.GENERALIZED_H3_RESOLUTION },
    },
    now: () => new Date(),
    logger,
  });
  process.exitCode = report.errors.length ? 1 : 0;
}
