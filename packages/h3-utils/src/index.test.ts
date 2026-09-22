import { describe, it, expect } from 'vitest';
import { latLngToCell, kRing, H3_RESOLUTIONS } from './index';

describe('H3 Utils Core Functions', () => {
  const INDIA_GATE = { lat: 28.6129, lng: 77.2295 };

 it('converts coordinates to operational resolution (Res 8)', () => {
    const cell = latLngToCell(INDIA_GATE.lat, INDIA_GATE.lng, H3_RESOLUTIONS.OPERATIONAL);
    expect(typeof cell).toBe('string');
    expect(cell).toBe('883da1143dfffff');
  });

  it('converts coordinates to federated resolution (Res 6)', () => {
    const cell = latLngToCell(INDIA_GATE.lat, INDIA_GATE.lng, H3_RESOLUTIONS.FEDERATED);
    expect(typeof cell).toBe('string');
    expect(cell).toBe('863da1147ffffff');
  });
  it('defaults to operational resolution (Res 8)', () => {
    const defaultCell = latLngToCell(INDIA_GATE.lat, INDIA_GATE.lng);
    const res8Cell = latLngToCell(INDIA_GATE.lat, INDIA_GATE.lng, H3_RESOLUTIONS.OPERATIONAL);
    expect(defaultCell).toBe(res8Cell);
  });

  it('returns 7 cells for a k-ring of 1', () => {
    const centerCell = latLngToCell(INDIA_GATE.lat, INDIA_GATE.lng);
    const ring = kRing(centerCell, 1);
    expect(ring).toHaveLength(7);
    expect(ring).toContain(centerCell);
  });
});