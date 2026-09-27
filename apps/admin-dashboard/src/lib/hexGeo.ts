import { cellToBoundary } from 'h3-js';

export const HIDDEN_STROKE = '#EFA22A';

/** What the hex map draws: any H3 cell (res 8 operational, res 6 federated). */
export interface HexDatum {
  h3Index: string;
  score: number; // 0..1
  /** Outlined in amber (a hidden hotspot on the operational grid). */
  highlight?: boolean;
  /** Tooltip / schematic title. */
  label?: string;
}

export function confidenceColor(score: number): string {
  if (score >= 0.75) return '#B91C1C';
  if (score >= 0.5) return '#EA580C';
  if (score >= 0.25) return '#EAB308';
  return '#94A3B8';
}

/** One GeoJSON hexagon per H3 cell ([lng, lat] order, closed ring);
 *  properties carry what the Data-layer style needs. */
export function hexesToGeoJson(cells: HexDatum[]) {
  return {
    type: 'FeatureCollection' as const,
    features: cells.map((c) => ({
      type: 'Feature' as const,
      id: c.h3Index,
      properties: { h3Index: c.h3Index, score: c.score, highlight: Boolean(c.highlight) },
      geometry: { type: 'Polygon' as const, coordinates: [cellToBoundary(c.h3Index, true)] },
    })),
  };
}
