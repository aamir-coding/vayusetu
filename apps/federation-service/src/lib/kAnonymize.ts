import { cellToParent, getResolution, isValidCell } from 'h3-js';

/**
 * Everything published to the National Exchange passes through here first.
 * PRODUCT_SPEC Feature 4: aggregates are "only published where the underlying
 * citizen-report count clears a minimum threshold, and at a lower H3
 * resolution than the internal operational grid". DB_SCHEMA's
 * federation_exchange.hotspot_summary fixes the output shape; its example
 * buckets ('10-50', '50-200', '200+') imply a floor of 10.
 *
 * DESIGN DECISION (flagged in WEEK3_SETUP.md): the gate counts DISTINCT
 * CONTRIBUTORS (>= k), not just reports. A report-count threshold alone is not
 * k-anonymity: one citizen filing 10 reports from their doorstep would pass it
 * and their location would be published. Both floors must clear.
 *
 * Coarsening applied:
 *   space  res-8 (~0.7 km2) -> res-6 (~36 km2) parent cells
 *   time   hourly -> one ISO week (Mon-Sun, IST)
 *   counts exact -> bucket label, never the number
 *   score  mean rounded to 2 dp
 * Never emitted: user ids, res-8 cells, exact counts, per-hour values.
 */

export interface KAnonymityOptions {
  /** Minimum DISTINCT contributors per generalized cell. */
  minContributors: number;
  /** Minimum reports per generalized cell (the DDL's bucket floor). */
  minReports: number;
  /** Target H3 resolution; must be coarser than every input cell. */
  generalizedResolution: number;
}

export const DEFAULT_K_OPTIONS: KAnonymityOptions = { minContributors: 10, minReports: 10, generalizedResolution: 6 };

/** One hourly HotspotCell observation (internal grid). */
export interface HotspotObservation {
  h3Index: string;
  hotspotConfidenceScore: number;
  /** HotspotCell.modelVersion -- feeds the summary's model_version column. */
  modelVersion?: string;
}

/** One citizen submission, reduced to what k-anonymity needs. */
export interface Contribution {
  h3Index: string;
  userId: string;
  stateCode: string;
}

/** Exactly the DB_SCHEMA.md federation_exchange.hotspot_summary columns. */
export interface HotspotSummaryRow {
  source_state_code: string;
  h3_index_generalized: string;
  week_start_date: string; // YYYY-MM-DD
  avg_hotspot_confidence: number;
  underlying_report_count_bucket: '10-50' | '50-200' | '200+';
  model_version: string;
  shared_at: string; // ISO timestamp
}

export interface KAnonymizeResult {
  rows: HotspotSummaryRow[];
  /** Counts only -- safe to log. */
  suppressed: { belowContributorFloor: number; belowReportFloor: number; noContributions: number };
}

export function reportBucket(reports: number, minReports: number): HotspotSummaryRow['underlying_report_count_bucket'] | null {
  if (reports < Math.max(10, minReports)) return null;
  if (reports < 50) return '10-50';
  if (reports < 200) return '50-200';
  return '200+';
}

function parentOf(h3Index: string, resolution: number): string | null {
  if (!isValidCell(h3Index)) return null;
  // A cell already at/above the target resolution cannot be generalized to it;
  // drop rather than publish it at its (possibly finer) native resolution.
  if (getResolution(h3Index) <= resolution) return null;
  return cellToParent(h3Index, resolution);
}

/** Deterministic majority; ties broken alphabetically so reruns are stable. */
function majority(counts: Map<string, number>): string {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

export function kAnonymizeWeek(args: {
  observations: HotspotObservation[];
  contributions: Contribution[];
  weekStartDate: string;
  modelVersion: string;
  sharedAt: string;
  options?: Partial<KAnonymityOptions>;
}): KAnonymizeResult {
  const opts = { ...DEFAULT_K_OPTIONS, ...args.options };
  if (opts.minContributors < 2) throw new Error('minContributors must be >= 2 (k=1 is not anonymity)');

  const scores = new Map<string, { sum: number; n: number }>();
  for (const o of args.observations) {
    const p = parentOf(o.h3Index, opts.generalizedResolution);
    if (!p || !Number.isFinite(o.hotspotConfidenceScore)) continue;
    const agg = scores.get(p) ?? { sum: 0, n: 0 };
    agg.sum += o.hotspotConfidenceScore;
    agg.n += 1;
    scores.set(p, agg);
  }

  const people = new Map<string, { users: Set<string>; reports: number; states: Map<string, number> }>();
  for (const c of args.contributions) {
    const p = parentOf(c.h3Index, opts.generalizedResolution);
    if (!p) continue;
    const agg = people.get(p) ?? { users: new Set(), reports: 0, states: new Map() };
    agg.users.add(c.userId);
    agg.reports += 1;
    agg.states.set(c.stateCode, (agg.states.get(c.stateCode) ?? 0) + 1);
    people.set(p, agg);
  }

  const suppressed = { belowContributorFloor: 0, belowReportFloor: 0, noContributions: 0 };
  const rows: HotspotSummaryRow[] = [];

  for (const [cell, s] of scores) {
    const p = people.get(cell);
    if (!p) {
      suppressed.noContributions++;
      continue;
    }
    if (p.users.size < opts.minContributors) {
      suppressed.belowContributorFloor++;
      continue;
    }
    const bucket = reportBucket(p.reports, opts.minReports);
    if (!bucket) {
      suppressed.belowReportFloor++;
      continue;
    }
    rows.push({
      // Every published cell has >= k contributions, so its state comes from
      // real, geocoded submissions -- no guessing for border cells.
      source_state_code: majority(p.states),
      h3_index_generalized: cell,
      week_start_date: args.weekStartDate,
      avg_hotspot_confidence: Math.round((s.sum / s.n) * 100) / 100,
      underlying_report_count_bucket: bucket,
      model_version: args.modelVersion,
      shared_at: args.sharedAt,
    });
  }

  rows.sort((a, b) => a.h3_index_generalized.localeCompare(b.h3_index_generalized));
  return { rows, suppressed };
}

const IST_OFFSET_MS = 330 * 60_000;

/**
 * The most recent COMPLETE week, Monday 00:00 IST to the next Monday, as UTC
 * instants plus the IST Monday date. Only complete weeks are published, so
 * every nightly rerun during a week republishes the same, finished data.
 */
export function lastCompleteWeekIst(now: Date): { weekStartDate: string; startUtc: Date; endUtc: Date } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const dow = (ist.getUTCDay() + 6) % 7; // Mon=0
  const thisMondayIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - dow);
  const lastMondayIst = thisMondayIst - 7 * 86_400_000;
  return {
    weekStartDate: new Date(lastMondayIst).toISOString().slice(0, 10),
    startUtc: new Date(lastMondayIst - IST_OFFSET_MS),
    endUtc: new Date(thisMondayIst - IST_OFFSET_MS),
  };
}
