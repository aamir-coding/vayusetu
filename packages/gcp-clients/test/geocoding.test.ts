import { describe, expect, it, vi } from 'vitest';
import { GeocodingError, createJurisdictionResolver, parseJurisdiction } from '../src/geocoding.js';

const comp = (long_name: string, type: string) => ({ long_name, short_name: long_name, types: [type, 'political'] });

function okResponse(...components: ReturnType<typeof comp>[]) {
  return { status: 'OK', results: [{ address_components: components }] };
}

function fetchReturning(...bodies: Array<{ status?: number; body?: unknown; throws?: Error }>) {
  const fn = vi.fn();
  for (const b of bodies) {
    if (b.throws) fn.mockRejectedValueOnce(b.throws);
    else fn.mockResolvedValueOnce(new Response(JSON.stringify(b.body ?? {}), { status: b.status ?? 200 }));
  }
  return fn as unknown as typeof fetch;
}

const FALLBACK = { stateCode: 'DL', districtCode: 'DL-CENTRAL' };

describe('parseJurisdiction', () => {
  it('maps a Delhi district through the alias table, not the naive slug', () => {
    const j = parseJurisdiction(
      okResponse(comp('Central Delhi', 'administrative_area_level_2'), comp('Delhi', 'administrative_area_level_1')),
    );
    expect(j).toEqual({ stateCode: 'DL', districtCode: 'DL-CENTRAL' });
  });

  it('skips a "... Division" level-2 component and uses the level-3 district', () => {
    const j = parseJurisdiction(
      okResponse(
        comp('Pune', 'administrative_area_level_3'),
        comp('Pune Division', 'administrative_area_level_2'),
        comp('Maharashtra', 'administrative_area_level_1'),
      ),
    );
    expect(j).toEqual({ stateCode: 'MH', districtCode: 'MH-PUNE' });
  });

  it('finds admin levels across results, not only results[0]', () => {
    const res = {
      status: 'OK',
      results: [
        { address_components: [comp('Connaught Place', 'sublocality')] },
        { address_components: [comp('New Delhi', 'administrative_area_level_2'), comp('Delhi', 'administrative_area_level_1')] },
      ],
    };
    expect(parseJurisdiction(res)).toEqual({ stateCode: 'DL', districtCode: 'DL-NEW-DELHI' });
  });

  it('warns when it has to generate an unmapped district code', () => {
    const warn = vi.fn();
    const j = parseJurisdiction(
      okResponse(comp('Faridabad', 'administrative_area_level_2'), comp('Haryana', 'administrative_area_level_1')),
      { warn },
    );
    expect(j).toEqual({ stateCode: 'HR', districtCode: 'HR-FARIDABAD' });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('returns state-only when no district-level component exists', () => {
    expect(parseJurisdiction(okResponse(comp('Rajasthan', 'administrative_area_level_1')))).toEqual({ stateCode: 'RJ' });
  });
});

describe('createJurisdictionResolver', () => {
  const delhi = okResponse(comp('Central Delhi', 'administrative_area_level_2'), comp('Delhi', 'administrative_area_level_1'));

  it('returns the fallback without calling the API when no key is set', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = createJurisdictionResolver({ fallback: FALLBACK, fetchImpl });
    expect(await r.resolve({ lat: 28.6, lng: 77.2 })).toEqual(FALLBACK);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.usingFallback).toBe(true);
  });

  it('retries a transient failure once, then succeeds', async () => {
    const fetchImpl = fetchReturning({ body: { status: 'UNKNOWN_ERROR', results: [] } }, { body: delhi });
    const r = createJurisdictionResolver({ apiKey: 'k', fallback: FALLBACK, fetchImpl });
    expect(await r.resolve({ lat: 28.63, lng: 77.22 })).toEqual({ stateCode: 'DL', districtCode: 'DL-CENTRAL' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats network errors/timeouts as transient', async () => {
    const fetchImpl = fetchReturning({ throws: new Error('The operation was aborted due to timeout') }, { body: delhi });
    const r = createJurisdictionResolver({ apiKey: 'k', fallback: FALLBACK, fetchImpl });
    await expect(r.resolve({ lat: 28.63, lng: 77.22 })).resolves.toMatchObject({ stateCode: 'DL' });
  });

  it('does NOT retry a config error (bad key) and surfaces kind=config', async () => {
    const fetchImpl = fetchReturning({ body: { status: 'REQUEST_DENIED', results: [], error_message: 'bad key' } });
    const r = createJurisdictionResolver({ apiKey: 'k', fallback: FALLBACK, fetchImpl });
    const err = await r.resolve({ lat: 28.6, lng: 77.2 }).catch((e) => e);
    expect(err).toBeInstanceOf(GeocodingError);
    expect(err.kind).toBe('config');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces ZERO_RESULTS as kind=no_result', async () => {
    const fetchImpl = fetchReturning({ body: { status: 'ZERO_RESULTS', results: [] } });
    const r = createJurisdictionResolver({ apiKey: 'k', fallback: FALLBACK, fetchImpl });
    await expect(r.resolve({ lat: 0, lng: 0 })).rejects.toMatchObject({ kind: 'no_result' });
  });

  it('caches by ~110 m grid so nearby repeat points cost one API call', async () => {
    const fetchImpl = fetchReturning({ body: delhi });
    const r = createJurisdictionResolver({ apiKey: 'k', fallback: FALLBACK, fetchImpl });
    await r.resolve({ lat: 28.63001, lng: 77.22001 });
    await r.resolve({ lat: 28.63004, lng: 77.22004 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
