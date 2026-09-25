import type { GeoPoint, Jurisdiction } from '@vayusetu/shared-types';

/**
 * Reverse-geocodes a point to a `Jurisdiction`. Shared by submission-service
 * (every citizen report) and alert-service (hotspot cell centres), so both
 * produce IDENTICAL codes for the same place -- if they didn't, a district
 * admin would see a submission but never the alert generated from it.
 *
 * CONTRACT GAP (flag, don't paper over): `Jurisdiction.stateCode/districtCode`
 * are typed as LGD codes in API_CONTRACTS.md §4.1, but every fixture in the
 * repo uses short codes ('DL', 'DL-CENTRAL'), and the real LGD codes are
 * numeric. This file follows the de-facto fixture convention
 * (`<STATE>-<DISTRICT-SLUG>`). The canonical district list belongs in
 * data/seed/ (Engineer 4). Every code produced by the generic slug fallback
 * is logged, so gaps in DISTRICT_ALIASES surface in logs instead of as
 * silently invisible submissions.
 */

const STATE_NAME_TO_CODE: Record<string, string> = {
  delhi: 'DL',
  'national capital territory of delhi': 'DL',
  haryana: 'HR',
  'uttar pradesh': 'UP',
  rajasthan: 'RJ',
  maharashtra: 'MH',
  punjab: 'PB',
};

/** Keyed by normalized Google name (see normalize()). Delhi's 11 districts all
 *  contain the word "Delhi", which a naive slug would turn into e.g.
 *  "DL-CENTRAL-DELHI" -- a code that matches no provisioned officer. */
const DISTRICT_ALIASES: Record<string, string> = {
  'central delhi': 'DL-CENTRAL',
  'east delhi': 'DL-EAST',
  'new delhi': 'DL-NEW-DELHI',
  'north delhi': 'DL-NORTH',
  'north east delhi': 'DL-NORTH-EAST',
  'northeast delhi': 'DL-NORTH-EAST',
  'north west delhi': 'DL-NORTH-WEST',
  'northwest delhi': 'DL-NORTH-WEST',
  shahdara: 'DL-SHAHDARA',
  'south delhi': 'DL-SOUTH',
  'south east delhi': 'DL-SOUTH-EAST',
  'southeast delhi': 'DL-SOUTH-EAST',
  'south west delhi': 'DL-SOUTH-WEST',
  'southwest delhi': 'DL-SOUTH-WEST',
  'west delhi': 'DL-WEST',
  gurgaon: 'HR-GURUGRAM',
  gurugram: 'HR-GURUGRAM',
};

export type GeocodingErrorKind = 'transient' | 'no_result' | 'config';

export class GeocodingError extends Error {
  constructor(
    message: string,
    readonly kind: GeocodingErrorKind,
  ) {
    super(message);
    this.name = 'GeocodingError';
  }
}

interface AddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}
interface GeocodeResponse {
  status: string;
  results: Array<{ address_components: AddressComponent[] }>;
  error_message?: string;
}

export interface JurisdictionResolverOptions {
  /** Unset => every point resolves to `fallback` (local dev without a Maps key). */
  apiKey?: string;
  fallback: Jurisdiction;
  timeoutMs?: number;
  /** Extra attempts after the first, for transient failures only. */
  retries?: number;
  cacheMaxEntries?: number;
  fetchImpl?: typeof fetch;
  logger?: { warn: (msg: string) => void };
}

export interface JurisdictionResolver {
  resolve(geo: GeoPoint): Promise<Jurisdiction>;
  readonly usingFallback: boolean;
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/\s+district$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Scan every result, not just results[0]: Google orders results from most to
 *  least specific, and the most specific one often omits admin levels. */
function findAcross(res: GeocodeResponse, type: string): AddressComponent | undefined {
  for (const r of res.results) {
    const hit = r.address_components.find((c) => c.types.includes(type));
    if (hit) return hit;
  }
  return undefined;
}

export function parseJurisdiction(
  res: GeocodeResponse,
  logger?: { warn: (msg: string) => void },
): Jurisdiction {
  const state = findAcross(res, 'administrative_area_level_1');
  if (!state) throw new GeocodingError('No state-level component in geocoding result', 'no_result');

  const stateCode = STATE_NAME_TO_CODE[normalize(state.long_name)] ?? slug(state.short_name);

  // In Google's India data, administrative_area_level_2 is frequently a
  // revenue *division* ("Pune Division") and the district sits at level 3.
  // Skip anything named "... Division".
  const districtComponent = ['administrative_area_level_2', 'administrative_area_level_3', 'locality']
    .map((t) => findAcross(res, t))
    .find((c): c is AddressComponent => Boolean(c) && !/\bdivision$/i.test(c!.long_name));

  if (!districtComponent) return { stateCode };

  const alias = DISTRICT_ALIASES[normalize(districtComponent.long_name)];
  if (alias) return { stateCode, districtCode: alias };

  const generated = `${stateCode}-${slug(districtComponent.long_name)}`;
  logger?.warn(
    `Unmapped district "${districtComponent.long_name}" -> generated code "${generated}". ` +
      'If officials are provisioned with a different code for this district, add an alias in ' +
      'packages/gcp-clients/src/geocoding.ts (canonical list: data/seed/, Engineer 4).',
  );
  return { stateCode, districtCode: generated };
}

export function createJurisdictionResolver(opts: JurisdictionResolverOptions): JurisdictionResolver {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const retries = opts.retries ?? 1;
  const maxEntries = opts.cacheMaxEntries ?? 5000;
  const doFetch = opts.fetchImpl ?? fetch;
  const cache = new Map<string, Jurisdiction>();
  let warnedNoKey = false;

  async function callApi(geo: GeoPoint): Promise<GeocodeResponse> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${geo.lat},${geo.lng}`);
    url.searchParams.set('key', opts.apiKey!);
    url.searchParams.set('language', 'en'); // alias table keys are English
    url.searchParams.set('region', 'in');

    let res: Response;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new GeocodingError(`Geocoding request failed: ${(error as Error).message}`, 'transient');
    }
    if (res.status >= 500) throw new GeocodingError(`Geocoding API HTTP ${res.status}`, 'transient');
    if (!res.ok) throw new GeocodingError(`Geocoding API HTTP ${res.status}`, 'config');

    const body = (await res.json()) as GeocodeResponse;
    switch (body.status) {
      case 'OK':
        return body;
      case 'ZERO_RESULTS':
        throw new GeocodingError('No geocoding result for this location', 'no_result');
      case 'OVER_QUERY_LIMIT':
      case 'UNKNOWN_ERROR':
        throw new GeocodingError(`Geocoding API status ${body.status}`, 'transient');
      default:
        // REQUEST_DENIED / INVALID_REQUEST: a key or API-enablement problem, not the caller's.
        throw new GeocodingError(
          `Geocoding API status ${body.status}${body.error_message ? `: ${body.error_message}` : ''}`,
          'config',
        );
    }
  }

  return {
    get usingFallback() {
      return !opts.apiKey;
    },

    async resolve(geo: GeoPoint): Promise<Jurisdiction> {
      if (!opts.apiKey) {
        if (!warnedNoKey) {
          opts.logger?.warn(
            'GOOGLE_MAPS_API_KEY not set -- every location resolves to the configured fallback ' +
              `(${opts.fallback.stateCode}/${opts.fallback.districtCode ?? '-'}). Fine for local dev only.`,
          );
          warnedNoKey = true;
        }
        return opts.fallback;
      }

      // ~110 m grid. Repeated reports from the same street reuse one API call.
      const key = `${geo.lat.toFixed(3)},${geo.lng.toFixed(3)}`;
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key); // LRU: refresh recency
        cache.set(key, cached);
        return cached;
      }

      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const jurisdiction = parseJurisdiction(await callApi(geo), opts.logger);
          cache.set(key, jurisdiction);
          if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
          return jurisdiction;
        } catch (error) {
          lastError = error;
          if (!(error instanceof GeocodingError) || error.kind !== 'transient') throw error;
        }
      }
      throw lastError;
    },
  };
}
