import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cellToLatLng, isValidCell } from 'h3-js';
import type { FederatedModel } from '@vayusetu/shared-types';
import { ApiHttpError } from '../lib/errors.js';
import { requireOfficial, requireRole } from '../plugins/auth.js';
import { type HotspotSummaryRow, lastCompleteWeekIst } from '../lib/kAnonymize.js';
import {
  type ExchangeStore,
  type FederationStateStore,
  type ModelRegistry,
  type ModelType,
  publicModel,
  toFederatedModel,
} from '../lib/ports.js';

export interface FederationRouteDeps {
  state: FederationStateStore;
  exchange: ExchangeStore;
  registry: ModelRegistry;
  cfg: {
    stateCode: string;
    featureSchemaVersions: Record<string, string>;
    lookbackWeeks: number;
    importTimeoutMs: number;
  };
  now: () => Date;
}

const ModelsQuery = z.object({ type: z.enum(['hotspot', 'forecast']).optional() });

/** "minLat,minLng,maxLat,maxLng" */
const BboxQuery = z.object({
  bbox: z
    .string()
    .transform((s) => s.split(',').map(Number))
    .refine(
      (n) =>
        n.length === 4 && n.every(Number.isFinite) &&
        n[0]! >= -90 && n[2]! <= 90 && n[1]! >= -180 && n[3]! <= 180 && n[0]! <= n[2]! && n[1]! <= n[3]!,
      { message: 'bbox must be minLat,minLng,maxLat,maxLng' },
    )
    .optional(),
});

const SUMMARY_CACHE_MS = 10 * 60_000; // the exchange changes nightly

function localImportId(modelId: string): string {
  return `imported-${modelId}`.slice(0, 63).replace(/-$/, '');
}

export default async function federationRoutes(app: FastifyInstance, opts: { deps: FederationRouteDeps }) {
  const { deps } = opts;
  let summaryCache: { since: string; rows: HotspotSummaryRow[]; at: number } | undefined;

  /**
   * `available` = other states' models from the local Firestore mirror (fast,
   * and still works if the exchange project is down). Own-state models are
   * excluded: they're what's already running here.
   * `currentlyActive` = the imported model pointer if one is set, else this
   * state's own latest shared model. CONTRACT NOTE: it is only meaningful for
   * one type, so without ?type= it is null (flagged in WEEK3_SETUP.md).
   */
  app.get('/federation/models', async (request, reply) => {
    const caller = await requireOfficial(request);
    requireRole(caller, ['state_admin', 'super_admin']);
    const { type } = ModelsQuery.parse(request.query);

    const mirrored = await deps.state.listMirroredModels(type);
    const available = mirrored.filter((m) => m.sourceStateCode !== deps.cfg.stateCode).map(publicModel);

    let currentlyActive: FederatedModel | null = null;
    if (type) {
      const active = await deps.state.getActive(type);
      const match = active
        ? mirrored.find((m) => m.id === active.modelId)
        : mirrored.find((m) => m.sourceStateCode === deps.cfg.stateCode); // newest first
      currentlyActive = match ? publicModel(match) : null;
    }
    reply.send({ available, currentlyActive });
  });

  /**
   * super_admin only. Reads the EXCHANGE catalog (authoritative, not the
   * mirror), checks the feature schema, copies the model into this project's
   * registry, then sets the active pointer hotspot-/forecast-service read.
   * Idempotent: re-importing the active model returns the existing activation.
   */
  app.post('/federation/models/:modelId/import', async (request, reply) => {
    const caller = await requireOfficial(request);
    requireRole(caller, ['super_admin']);
    const { modelId } = request.params as { modelId: string };

    const record = await deps.exchange.getSharedModel(modelId);
    if (!record || record.source_state_code === deps.cfg.stateCode) {
      // Own-state models aren't in `available` either -- nothing to import.
      throw new ApiHttpError('NOT_FOUND', 'No importable shared model with that id');
    }

    const type = record.model_type as ModelType;
    const expected = deps.cfg.featureSchemaVersions[type];
    if (record.feature_schema_version !== expected) {
      throw new ApiHttpError('CONFLICT', 'Incompatible model schema version', {
        modelFeatureSchema: record.feature_schema_version,
        deploymentFeatureSchema: expected ?? null,
      });
    }

    const current = await deps.state.getActive(type);
    if (current?.modelId === modelId) {
      reply.send({ imported: publicModel(toFederatedModel(record)), activatedAt: current.activatedAt });
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const localVertexModel = await Promise.race([
      deps.registry.importFromExchange(record.vertex_model_registry_uri, localImportId(modelId)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          // The copy continues server-side; a retry is safe (ALREADY_EXISTS is resumed).
          () => reject(new ApiHttpError('INTERNAL_ERROR', 'Model copy still in progress; retry the import shortly')),
          deps.cfg.importTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));

    const activatedAt = deps.now().toISOString();
    await deps.state.setActive(type, { modelId, localVertexModel, activatedAt, activatedBy: caller.uid });

    try {
      await deps.exchange.recordImport(modelId, deps.cfg.stateCode, activatedAt);
      record.download_count += 1;
    } catch (error) {
      // downloadCount is informational; never fail an activation over it.
      request.log.warn({ err: error, modelId }, 'Failed to record import on the exchange');
    }

    request.log.info({ modelId, type, localVertexModel, by: caller.uid }, 'federated model imported and activated');
    reply.send({ imported: publicModel(toFederatedModel(record)), activatedAt });
  });

  /**
   * Cross-state aggregated view (Feature 4). Last SUMMARY_LOOKBACK_WEEKS
   * complete weeks, optionally clipped to a bbox by cell centre. Only rows
   * that already passed k-anonymity in their source state ever exist here.
   */
  app.get('/federation/exchange/hotspot-summary', async (request, reply) => {
    const caller = await requireOfficial(request);
    requireRole(caller, ['state_admin', 'super_admin']);
    const { bbox } = BboxQuery.parse(request.query);

    const latest = lastCompleteWeekIst(deps.now()).weekStartDate;
    const since = new Date(Date.parse(`${latest}T00:00:00Z`) - (deps.cfg.lookbackWeeks - 1) * 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const fresh = summaryCache && summaryCache.since === since && Date.now() - summaryCache.at < SUMMARY_CACHE_MS;
    if (!fresh) summaryCache = { since, rows: await deps.exchange.hotspotSummarySince(since), at: Date.now() };

    const summary = summaryCache!.rows
      .filter((r) => {
        if (!bbox) return true;
        if (!isValidCell(r.h3_index_generalized)) return false;
        const [lat, lng] = cellToLatLng(r.h3_index_generalized);
        return lat >= bbox[0]! && lat <= bbox[2]! && lng >= bbox[1]! && lng <= bbox[3]!;
      })
      .map((r) => ({
        sourceStateCode: r.source_state_code,
        h3IndexGeneralized: r.h3_index_generalized,
        weekStartDate: r.week_start_date,
        avgHotspotConfidence: r.avg_hotspot_confidence,
      }));
    reply.send({ summary });
  });
}
