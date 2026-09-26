import type { AlertStatus } from '@vayusetu/shared-types';

/**
 * Source of truth for PATCH /alerts/:id/status (API_CONTRACTS.md gives one
 * example of an invalid move: resolved -> new). Design constraints:
 *  - packages/ui-components' ALERT_STATUS_SUGGESTED_NEXT (the dashboard's
 *    button heuristic) must be a SUBSET of this map, so no button the UI
 *    offers can ever 409. Verified in test/domain.test.ts.
 *  - dismissed is terminal; resolved can only be re-opened to in_progress.
 *  - Stricter than the admin-dashboard MSW mock, which permitted backwards
 *    moves like in_progress -> acknowledged. Flagged in WEEK2_SETUP.md.
 */
export const ALLOWED_TRANSITIONS: Record<AlertStatus, readonly AlertStatus[]> = {
  new: ['acknowledged', 'in_progress', 'resolved', 'dismissed'],
  acknowledged: ['in_progress', 'resolved', 'dismissed'],
  in_progress: ['resolved', 'dismissed'],
  resolved: ['in_progress'],
  dismissed: [],
};

export const OPEN_STATUSES: readonly AlertStatus[] = ['new', 'acknowledged', 'in_progress'];

/**
 * 'noop' = same status requested again. Treated as idempotent success (200,
 * no new history entry) rather than 409: on a flaky 3G link the dashboard
 * may retry a PATCH whose first attempt actually landed, and the official
 * should not see an error for getting exactly the state they asked for.
 */
export function checkTransition(from: AlertStatus, to: AlertStatus): 'ok' | 'noop' | 'invalid' {
  if (from === to) return 'noop';
  return ALLOWED_TRANSITIONS[from].includes(to) ? 'ok' : 'invalid';
}
