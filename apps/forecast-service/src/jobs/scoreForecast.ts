// Cloud Run Job entrypoint (every 6 h, Cloud Scheduler): one ForecastRun per
// configured corridor.   node --import tsx src/jobs/scoreForecast.ts [--at ISO]
import pino from 'pino';
import { env } from '../config/env.js';
import { runForecast } from '../domain/run.js';
import { buildRunDeps } from '../wiring.js';

const log = pino({ level: 'info' });

function runTimestamp(argv: string[]): Date {
  const i = argv.indexOf('--at');
  const t = i >= 0 && argv[i + 1] ? new Date(argv[i + 1]!) : new Date();
  t.setUTCMinutes(0, 0, 0);
  return t;
}

const runTs = runTimestamp(process.argv);
const deps = buildRunDeps(log);
let failed = 0;
for (const corridorId of env.CORRIDOR_IDS) {
  try {
    const run = await runForecast(corridorId, runTs, deps);
    log.info({ id: run.id, horizons: run.horizons.map((h) => h.predictedAQI) }, 'corridor done');
  } catch (err) {
    failed++;
    log.error({ err, corridorId }, 'forecast failed');
  }
}
process.exit(failed ? 1 : 0);
