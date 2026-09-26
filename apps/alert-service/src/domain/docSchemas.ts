import { z } from 'zod';
import type { Corridor, ForecastRun, HotspotCell } from '@vayusetu/shared-types';

/**
 * Week 3: events are REAL now (Engineer 3's hotspot-service/forecast-service).
 * Week 2 trusted re-read docs by type assertion alone, so a producer writing a
 * slightly different shape would crash deep in the pipeline on `undefined`.
 * These mirror API_CONTRACTS.md §4.1 exactly and are checked at the boundary;
 * a violation is a NonRetryableEventError whose message names the offending
 * field, so the producer sees precisely what to fix in alert-service's logs.
 *
 * Keep in lock-step with packages/shared-types (the compile-time assertions
 * at the bottom fail the build if the two drift).
 */

const iso = z.string().datetime({ offset: true });
const grapStage = z.enum(['none', 'stage_1', 'stage_2', 'stage_3', 'stage_4']);
const aqiCategory = z.enum(['good', 'satisfactory', 'moderate', 'poor', 'very_poor', 'severe']);
const classification = z.enum([
  'crop_residue_burning', 'industrial_emission', 'open_waste_burning', 'vehicular_smog',
  'construction_dust', 'no_visible_pollution', 'indeterminate', 'mixed', 'unknown',
]);

export const HotspotCellSchema = z.object({
  id: z.string().min(1),
  h3Index: z.string().regex(/^[0-9a-f]{15}$/i, 'must be an H3 index'),
  corridorId: z.string().min(1),
  timestampHour: iso,
  hotspotConfidenceScore: z.number().min(0).max(1),
  isHidden: z.boolean(),
  classification,
  contributingSignals: z.object({
    citizenReportCount: z.number().int().min(0),
    avgCitizenSeverity: z.number().optional(),
    satelliteAOD: z.number().optional(),
    satelliteNO2: z.number().optional(),
    fireDetectionCount: z.number().int().min(0).optional(),
    nearestMonitorId: z.string().optional(),
    nearestMonitorDeltaAQI: z.number().optional(),
  }),
  modelVersion: z.string().min(1),
  createdAt: iso,
});

export const ForecastRunSchema = z.object({
  id: z.string().min(1),
  corridorId: z.string().min(1),
  forecastRunTimestamp: iso,
  horizons: z
    .array(
      z.object({
        horizonHours: z.union([z.literal(24), z.literal(48), z.literal(72)]),
        predictedAQI: z.number().min(0),
        predictedAQICategory: aqiCategory,
        predictedGRAPStage: grapStage,
        confidenceInterval: z.object({ lower: z.number(), upper: z.number() }),
      }),
    )
    .min(1),
  keyDrivers: z.array(z.string()),
  modelVersion: z.string().min(1),
  createdAt: iso,
});

const threshold = z.object({ aqiMin: z.number(), aqiMax: z.number() });
export const CorridorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  states: z.array(z.string().min(1)).min(1),
  boundaryGeoJsonStorageUrl: z.string(),
  population: z.number(),
  monitoringStationIds: z.array(z.string()),
  grapFrameworkActive: z.boolean(),
  grapThresholds: z
    .object({ stage_1: threshold, stage_2: threshold, stage_3: threshold, stage_4: threshold })
    .optional(),
  createdAt: z.string(),
});

/** "contributingSignals.citizenReportCount: Required; timestampHour: Invalid datetime" */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

// Compile-time drift guards against @vayusetu/shared-types.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _HotspotCellInSync = Assert<Same<z.infer<typeof HotspotCellSchema>, HotspotCell>>;
export type _ForecastRunInSync = Assert<Same<z.infer<typeof ForecastRunSchema>, ForecastRun>>;
export type _CorridorInSync = Assert<Same<z.infer<typeof CorridorSchema>, Corridor>>;
