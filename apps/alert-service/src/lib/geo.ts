import { cellToLatLng } from 'h3-js';
import { createJurisdictionResolver } from '@vayusetu/gcp-clients';
import type { GeoPoint, H3Index } from '@vayusetu/shared-types';
import { env } from '../config/env.js';

/**
 * CONTRACT GAP (same as submission-service/src/lib/h3.ts): h3-js used
 * directly until Engineer 4's packages/h3-utils lands; swap then.
 */
export function cellCenter(h3Index: H3Index): GeoPoint {
  const [lat, lng] = cellToLatLng(h3Index);
  return { lat, lng };
}

/** Same shared resolver submission-service uses -> identical district codes
 *  for a citizen report and the alert later raised on the same cell. */
export const jurisdictionResolver = createJurisdictionResolver({
  apiKey: env.GOOGLE_MAPS_API_KEY || undefined,
  fallback: { stateCode: env.DEFAULT_STATE_CODE, districtCode: env.DEFAULT_DISTRICT_CODE },
  logger: { warn: (msg) => console.warn(`[geocoding] ${msg}`) },
});
