import type { GeoPoint, Jurisdiction } from '@vayusetu/shared-types';
import { env } from '../config/env.js';

/**
 * PRD §3.2: "Jurisdiction-correct alert routing is impossible without
 * accurate reverse geocoding." Google's Geocoding API returns
 * `address_components` keyed by Google's own admin-level taxonomy
 * (administrative_area_level_1/2/3), which doesn't map 1:1 to India's
 * Local Government Directory (LGD) codes `Jurisdiction.stateCode` /
 * `districtCode` are typed against. STATE_NAME_TO_LGD below is a
 * deliberately small Week 1 seed covering the two pilot corridors (NCR:
 * Delhi/Haryana/UP/Rajasthan; Mumbai-Pune: Maharashtra) -- extend it as
 * new corridors are onboarded. A full LGD lookup table belongs in
 * `data/seed/` (Engineer 4, per DB_SCHEMA.md); this is a Week 1
 * stand-in, flagged here rather than silently pretending it's complete.
 */
const STATE_NAME_TO_LGD: Record<string, string> = {
  delhi: 'DL',
  'national capital territory of delhi': 'DL',
  haryana: 'HR',
  'uttar pradesh': 'UP',
  rajasthan: 'RJ',
  maharashtra: 'MH',
  punjab: 'PB',
};

interface GeocodingAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

interface GeocodingResult {
  address_components: GeocodingAddressComponent[];
  formatted_address: string;
}

interface GeocodingResponse {
  status: string;
  results: GeocodingResult[];
  error_message?: string;
}

function slugCode(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function findComponent(
  components: GeocodingAddressComponent[],
  type: string,
): GeocodingAddressComponent | undefined {
  return components.find((c) => c.types.includes(type));
}

let hasWarnedNoApiKey = false;

/**
 * Resolves a GeoPoint to a Jurisdiction. Falls back to
 * DEFAULT_STATE_CODE/DEFAULT_DISTRICT_CODE (.env.example) when
 * GOOGLE_MAPS_API_KEY isn't set, so this service is runnable end-to-end
 * on Day 1 before Secret Manager/Terraform has provisioned a real key --
 * mirroring how the frontend apps run fully in mock mode with zero env
 * vars set. This must never be the silent behavior in a deployed
 * environment; index.ts logs a warning every time this path is hit.
 */
export async function resolveJurisdiction(geo: GeoPoint): Promise<Jurisdiction> {
  if (!env.GOOGLE_MAPS_API_KEY) {
    if (!hasWarnedNoApiKey) {
      console.warn(
        '\u26a0\ufe0f  GOOGLE_MAPS_API_KEY not set -- resolveJurisdiction() is returning the ' +
          `configured default (${env.DEFAULT_STATE_CODE}/${env.DEFAULT_DISTRICT_CODE}) for every ` +
          'submission instead of reverse-geocoding. Fine for local dev; must be set before any real pilot.',
      );
      hasWarnedNoApiKey = true;
    }
    return { stateCode: env.DEFAULT_STATE_CODE, districtCode: env.DEFAULT_DISTRICT_CODE };
  }

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${geo.lat},${geo.lng}`);
  url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);
  url.searchParams.set(
    'result_type',
    'administrative_area_level_1|administrative_area_level_2|administrative_area_level_3|locality',
  );

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Geocoding API HTTP ${res.status}`);
  }
  const body = (await res.json()) as GeocodingResponse;
  if (body.status !== 'OK' || body.results.length === 0) {
    throw new Error(
      `Geocoding API returned status "${body.status}"${body.error_message ? `: ${body.error_message}` : ''}`,
    );
  }

  const components = body.results[0]!.address_components;
  const stateComponent = findComponent(components, 'administrative_area_level_1');
  const districtComponent =
    findComponent(components, 'administrative_area_level_2') ??
    findComponent(components, 'administrative_area_level_3') ??
    findComponent(components, 'locality');

  const stateCode = stateComponent
    ? (STATE_NAME_TO_LGD[stateComponent.long_name.toLowerCase()] ?? slugCode(stateComponent.short_name))
    : env.DEFAULT_STATE_CODE;
  const districtCode = districtComponent ? `${stateCode}-${slugCode(districtComponent.long_name)}` : undefined;

  return districtCode ? { stateCode, districtCode } : { stateCode };
}
