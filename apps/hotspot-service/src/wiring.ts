import { publishEvent } from '@vayusetu/gcp-clients';
import { env } from './config/env.js';
import { createDataAdapters } from './adapters/data.js';
import type { FastPathDeps } from './domain/fastPath.js';
import type { HourlyDeps } from './domain/hourly.js';
import { createBatchScorer, createEndpointScorer, everyNHours, heuristicScorer, withFallback, type ModelScorer } from './scoring/scorers.js';

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: object, msg: string): void };

export function dataAdapters() {
  return createDataAdapters({ project: env.GOOGLE_CLOUD_PROJECT, dataset: env.BQ_DATASET, location: env.BQ_LOCATION });
}

const publishHotspotUpdated: HourlyDeps['publishHotspotUpdated'] = async (p) => {
  await publishEvent('hotspot.updated', p);
};

export function buildScorer(data: ReturnType<typeof dataAdapters>, log: Log): ModelScorer {
  switch (env.HOTSPOT_SCORER) {
    case 'endpoint':
      return withFallback(createEndpointScorer({ project: env.GOOGLE_CLOUD_PROJECT, location: env.VERTEX_LOCATION, endpointId: env.HOTSPOT_ENDPOINT_ID! }), log);
    case 'batch':
      return everyNHours(
        withFallback(
          createBatchScorer({
            project: env.GOOGLE_CLOUD_PROJECT,
            location: env.VERTEX_LOCATION,
            modelResource: env.HOTSPOT_MODEL!,
            dataset: env.BQ_DATASET,
            readRows: (sql) => data.query(sql),
          }),
          log,
        ),
        env.HOTSPOT_MODEL_EVERY_HOURS,
      );
    default:
      return heuristicScorer;
  }
}

export function buildHourlyDeps(log: Log): HourlyDeps {
  const data = dataAdapters();
  return {
    loadFeatures: (h) => data.loadFeatures(h),
    citizenModes: (h) => data.citizenModes(h),
    scorer: buildScorer(data, log),
    writeGrid: (h, c) => data.writeGrid(h, c),
    writeTopCells: (d) => data.writeTopCells(d),
    publishHotspotUpdated,
    now: () => new Date(),
    logger: log,
    config: {
      hiddenMinConfidence: env.HIDDEN_MIN_CONFIDENCE,
      modelHiddenMinConfidence: env.MODEL_HIDDEN_MIN_CONFIDENCE,
      firestoreMinScore: env.FIRESTORE_MIN_SCORE,
      firestoreMinCells: env.FIRESTORE_MIN_CELLS,
      firestoreMaxCells: env.FIRESTORE_MAX_CELLS,
      alertMinScore: env.ALERT_MIN_SCORE,
      alertMaxPerCorridor: env.ALERT_MAX_PER_CORRIDOR,
    },
  };
}

export function buildFastPathDeps(log: Log, data = dataAdapters()): FastPathDeps {
  return {
    cellInfo: (h3) => data.cellInfo(h3),
    publishHotspotUpdated,
    now: () => new Date(),
    logger: log,
    config: {
      hiddenMinConfidence: env.HIDDEN_MIN_CONFIDENCE,
      modelHiddenMinConfidence: env.MODEL_HIDDEN_MIN_CONFIDENCE,
      alertMinScore: env.ALERT_MIN_SCORE,
      minConfidence: env.CITIZEN_MIN_CONFIDENCE,
      minAgreement: env.CITIZEN_MIN_AGREEMENT,
    },
  };
}
