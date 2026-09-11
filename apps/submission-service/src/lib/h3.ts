import { latLngToCell } from 'h3-js';
import type { GeoPoint, H3Index } from '@vayusetu/shared-types';

/**
 * DB_SCHEMA.md: "H3 cell indices are computed at the application layer
 * using h3-js (Node services)... res 8 operational." `packages/h3-utils`
 * (Engineer 4, Week 1) is meant to centralize this exact call for every
 * consumer (this service, hotspot-service, forecast-service); until it
 * lands, submission-service depends on `h3-js` directly.
 *
 * CONTRACT GAP, flagged rather than silently worked around (matching this
 * repo's existing style -- see README's "Contract gaps found" section):
 * swap this file's body for `import { latLngToH3 } from '@vayusetu/h3-utils'`
 * the moment that package is published. Don't let this drift into its
 * own competing implementation once h3-utils exists.
 */
const OPERATIONAL_RESOLUTION = 8;

export function resolveH3Index(geo: GeoPoint): H3Index {
  return latLngToCell(geo.lat, geo.lng, OPERATIONAL_RESOLUTION);
}
