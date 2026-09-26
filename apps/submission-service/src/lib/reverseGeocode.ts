import { createJurisdictionResolver } from '@vayusetu/gcp-clients';
import { env } from '../config/env.js';

/**
 * Thin, service-local configuration of the shared resolver in
 * @vayusetu/gcp-clients (moved there in Week 2 so alert-service resolves
 * hotspot cells with byte-identical logic). Behaviour changes vs Week 1:
 *   - 3 s timeout + 1 retry on transient failures (was: no timeout at all)
 *   - failures now THROW a GeocodingError instead of being unhandled;
 *     routes/submissions.ts maps them to 400 / 500
 *   - Delhi district aliases + "Division" skipping (Week 1 would have
 *     produced "DL-CENTRAL-DELHI", matching no provisioned officer)
 */
export const jurisdictionResolver = createJurisdictionResolver({
  apiKey: env.GOOGLE_MAPS_API_KEY || undefined,
  fallback: { stateCode: env.DEFAULT_STATE_CODE, districtCode: env.DEFAULT_DISTRICT_CODE },
  logger: { warn: (msg) => console.warn(`[geocoding] ${msg}`) },
});
