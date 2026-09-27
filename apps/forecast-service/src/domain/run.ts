import type { Corridor, ForecastRun } from '@vayusetu/shared-types';
import type { Forecaster, InputRow } from '../scoring/forecasters.js';
import { aggregateHorizons, forecastRunId, HORIZONS, keyDrivers, type DriverInputs } from './aggregate.js';

export interface RunDeps {
  corridor(corridorId: string): Promise<Corridor | undefined>;
  /** Materialise core.forecast_input for (runTs, corridor); rows + the table batch prediction reads. */
  loadInput(runTs: Date, corridorId: string): Promise<{ rows: InputRow[]; inputTable?: string }>;
  forecaster: Forecaster;
  /** Firestore forecasts/{id} + core.forecast_runs. MUST complete before publishing (alert-service re-reads). */
  writeRun(run: ForecastRun & { contextSources: { measured: number; modeled: number } }): Promise<void>;
  publishForecastUpdated(p: { forecastRunId: string; corridorId: string; maxHorizonAQI: number }): Promise<void>;
  now(): Date;
  logger: { info(obj: object, msg: string): void };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

export function driverInputs(rows: InputRow[], runTs: Date): DriverInputs {
  const t0 = runTs.getTime();
  const horizon = rows.filter((r) => r.is_horizon);
  const recent = rows.filter((r) => !r.is_horizon && r.aqi != null && new Date(r.ts).getTime() >= t0 - 24 * 3_600_000);
  const lastContext = rows.filter((r) => !r.is_horizon).sort((a, b) => b.ts.localeCompare(a.ts))[0];
  const month = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', month: 'numeric' }).format(runTs));
  return {
    currentAqi: mean(recent.map((r) => r.aqi!)),
    meanWindSpeedMs: mean(horizon.flatMap((r) => (r.wind_speed_ms == null ? [] : [r.wind_speed_ms]))),
    meanHumidityPct: mean(horizon.flatMap((r) => (r.relative_humidity_pct == null ? [] : [r.relative_humidity_pct]))),
    harvestSeason: horizon.some((r) => r.is_harvest_season),
    diwaliWindow: horizon.some((r) => r.is_diwali_window),
    firesYesterday: lastContext?.corridor_fire_count_d1 ?? undefined,
    month,
  };
}

/** One forecast run for one corridor (Cloud Run Job, every 6 h). */
export async function runForecast(corridorId: string, runTs: Date, deps: RunDeps): Promise<ForecastRun> {
  const corridor = await deps.corridor(corridorId);
  if (!corridor) throw new Error(`corridors/${corridorId} not found -- run the ingestion seed job`);
  const { rows, inputTable } = await deps.loadInput(runTs, corridorId);
  const context = rows.filter((r) => !r.is_horizon && r.aqi != null);
  if (context.length === 0) throw new Error(`No AQI history for ${corridorId} before ${runTs.toISOString()} -- check ingestion`);

  const { predictions, modelVersion } = await deps.forecaster.forecast(rows, { runTs, inputTable });
  const horizons = aggregateHorizons(predictions, runTs, corridor);
  if (horizons.length !== HORIZONS.length) throw new Error(`Forecast covered ${horizons.length}/3 horizons for ${corridorId}`);

  const run: ForecastRun = {
    id: forecastRunId(corridorId, runTs),
    corridorId,
    forecastRunTimestamp: runTs.toISOString(),
    horizons,
    keyDrivers: keyDrivers(horizons, driverInputs(rows, runTs)),
    modelVersion,
    createdAt: deps.now().toISOString(),
  };
  const contextSources = {
    measured: context.filter((r) => r.target_source === 'measured').length,
    modeled: context.filter((r) => r.target_source === 'modeled').length,
  };
  await deps.writeRun({ ...run, contextSources });
  const maxHorizonAQI = Math.max(...horizons.map((h) => h.predictedAQI));
  await deps.publishForecastUpdated({ forecastRunId: run.id, corridorId, maxHorizonAQI });
  deps.logger.info({ id: run.id, modelVersion, maxHorizonAQI, contextSources, drivers: run.keyDrivers.length }, 'forecast run complete');
  return run;
}
