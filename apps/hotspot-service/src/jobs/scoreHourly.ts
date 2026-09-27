// Cloud Run Job entrypoint (hourly, Cloud Scheduler): score every cell for
// the hour that just ended.   node --import tsx src/jobs/scoreHourly.ts [--hour ISO]
import pino from 'pino';
import { runHourly } from '../domain/hourly.js';
import { buildHourlyDeps } from '../wiring.js';

const log = pino({ level: 'info' });

function targetHour(argv: string[]): Date {
  const i = argv.indexOf('--hour');
  if (i >= 0 && argv[i + 1]) return new Date(argv[i + 1]!);
  // Score the most recent COMPLETE hour: its weather (ingest-weather, :05)
  // and citizen rollup (ingest-rollup, :20) have landed by the time this runs.
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  return new Date(now.getTime() - 3_600_000);
}

try {
  const summary = await runHourly(targetHour(process.argv), buildHourlyDeps(log));
  log.info(summary, 'done');
  process.exit(0);
} catch (err) {
  log.error({ err }, 'hourly scoring failed');
  process.exit(1);
}
