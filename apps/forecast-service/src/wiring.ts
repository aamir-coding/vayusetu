import { publishEvent } from '@vayusetu/gcp-clients';
import { env } from './config/env.js';
import { createDataAdapters } from './adapters/data.js';
import type { RunDeps } from './domain/run.js';
import { createBatchForecaster, persistenceForecaster, withFallback, type Forecaster } from './scoring/forecasters.js';

type Log = { info(obj: object, msg: string): void; error(obj: object, msg: string): void };

export function buildRunDeps(log: Log): RunDeps {
  const data = createDataAdapters({ project: env.GOOGLE_CLOUD_PROJECT, dataset: env.BQ_DATASET, location: env.BQ_LOCATION });
  const forecaster: Forecaster =
    env.FORECASTER === 'batch'
      ? withFallback(
          createBatchForecaster({
            project: env.GOOGLE_CLOUD_PROJECT,
            location: env.VERTEX_LOCATION,
            modelResource: env.FORECAST_MODEL!,
            dataset: env.BQ_DATASET,
            readRows: (sql) => data.query(sql),
          }),
          log,
        )
      : persistenceForecaster;
  return {
    corridor: (id) => data.corridor(id),
    loadInput: (ts, id) => data.loadInput(ts, id),
    forecaster,
    writeRun: (run) => data.writeRun(run),
    publishForecastUpdated: async (p) => {
      await publishEvent('forecast.updated', p);
    },
    now: () => new Date(),
    logger: log,
  };
}
