import { describe, expect, it } from 'vitest';
import { getResolution } from 'h3-js';
import { confidenceColor, hexesToGeoJson } from '../src/lib/hexGeo';
import { hotspotCells } from '../src/mocks/fixtures';

describe('hexesToGeoJson', () => {
  it('emits a closed [lng, lat] hexagon per cell', () => {
    const c = hotspotCells[0]!;
    const fc = hexesToGeoJson([{ h3Index: c.h3Index, score: c.hotspotConfidenceScore, highlight: c.isHidden }]);
    const ring = fc.features[0]!.geometry.coordinates[0]!;
    expect(ring).toHaveLength(7); // 6 vertices + closing point
    expect(ring[0]).toEqual(ring[6]);
    const [lng, lat] = ring[0]!;
    // Delhi: lng ~77, lat ~28.7 -- catches a swapped axis order.
    expect(lng).toBeGreaterThan(76);
    expect(lat).toBeLessThan(30);
    expect(fc.features[0]!.properties).toMatchObject({ highlight: true, score: 0.91 });
  });
});

describe('fixtures', () => {
  it('use real res-8 cells (the operational grid), not placeholders', () => {
    for (const c of hotspotCells) expect(getResolution(c.h3Index)).toBe(8);
  });
});

describe('confidenceColor', () => {
  it('bands at 25/50/75%', () => {
    expect(confidenceColor(0.8)).toBe('#B91C1C');
    expect(confidenceColor(0.5)).toBe('#EA580C');
    expect(confidenceColor(0.25)).toBe('#EAB308');
    expect(confidenceColor(0.1)).toBe('#94A3B8');
  });
});
