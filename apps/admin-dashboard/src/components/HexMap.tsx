import * as React from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { cellToLatLng } from 'h3-js';
import { useTheme } from '@vayusetu/ui-components';
import { HIDDEN_STROKE, confidenceColor, hexesToGeoJson, type HexDatum } from '../lib/hexGeo';

/** Google's "night" styling (no map ID needed); hexes keep their data colours. */
const DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#1b2630' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1b2630' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a9ba8' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#3a4a55' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c3a44' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#212d36' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3b4b56' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1a22' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4e6270' }] },
];

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

/** H3 hexagons as a google.maps.Data layer: one draw call for thousands of
 *  cells, where per-cell <Polygon> components would each own a map object. */
function HexLayer({ cells, onSelect }: { cells: HexDatum[]; onSelect?: (h3Index: string) => void }) {
  const map = useMap();
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;

  React.useEffect(() => {
    if (!map) return;
    const layer = new google.maps.Data({ map });
    layer.addGeoJson(hexesToGeoJson(cells));
    layer.setStyle((f) => {
      const score = Number(f.getProperty('score'));
      const highlight = Boolean(f.getProperty('highlight'));
      return {
        fillColor: confidenceColor(score),
        fillOpacity: 0.15 + 0.6 * score,
        strokeColor: highlight ? HIDDEN_STROKE : confidenceColor(score),
        strokeWeight: highlight ? 3 : 0.5,
        zIndex: highlight ? 2 : 1,
      };
    });
    const click = layer.addListener('click', (e: google.maps.Data.MouseEvent) =>
      onSelectRef.current?.(String(e.feature.getProperty('h3Index'))),
    );
    if (cells.length > 0) {
      const bounds = new google.maps.LatLngBounds();
      for (const c of cells) {
        const [lat, lng] = cellToLatLng(c.h3Index);
        bounds.extend({ lat, lng });
      }
      map.fitBounds(bounds, 48);
    }
    return () => {
      click.remove();
      layer.setMap(null);
    };
  }, [map, cells]);

  return null;
}

/** Without a Maps key (mock mode, local dev) the same cells plot as a
 *  schematic so the screen stays usable; production always has the key. */
function SchematicPlot({ cells, onSelect }: { cells: HexDatum[]; onSelect?: (h3Index: string) => void }) {
  const W = 640;
  const H = 380;
  const PAD = 40;
  const points = React.useMemo(() => {
    const ll = cells.map((c) => cellToLatLng(c.h3Index));
    const lats = ll.map(([lat]) => lat);
    const lngs = ll.map(([, lng]) => lng);
    const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
    return cells.map((cell, i) => ({
      cell,
      x: PAD + ((ll[i]![1] - minLng) / (maxLng - minLng || 1)) * (W - PAD * 2),
      y: H - PAD - ((ll[i]![0] - minLat) / (maxLat - minLat || 1)) * (H - PAD * 2),
    }));
  }, [cells]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Hotspot confidence map (schematic)">
      <rect x={0} y={0} width={W} height={H} rx={12} className="fill-slate-50" />
      {points.map(({ cell, x, y }) => (
        <g key={cell.h3Index} transform={`translate(${x}, ${y})`} onClick={() => onSelect?.(cell.h3Index)} className="cursor-pointer">
          {cell.highlight && <circle r={20} fill="none" stroke={HIDDEN_STROKE} strokeWidth={2} strokeDasharray="4 3" />}
          <circle r={10 + cell.score * 10} fill={confidenceColor(cell.score)} fillOpacity={0.85} />
          {cell.label && <title>{cell.label}</title>}
        </g>
      ))}
    </svg>
  );
}

export function HexMap({
  cells,
  onSelect,
  center,
  zoom,
  height = '32rem',
  mapKey,
}: {
  cells: HexDatum[];
  onSelect?: (h3Index: string) => void;
  center: google.maps.LatLngLiteral;
  zoom: number;
  height?: string;
  /** Changing it remounts the map (e.g. per corridor). */
  mapKey?: string;
}) {
  const { resolved } = useTheme();
  if (!MAPS_KEY) {
    return (
      <div className="p-4">
        <SchematicPlot cells={cells} onSelect={onSelect} />
      </div>
    );
  }
  return (
    <APIProvider apiKey={MAPS_KEY} language="en" region="IN">
      <Map
        // colorScheme is fixed at creation, so the theme is part of the key.
        key={`${mapKey ?? 'map'}-${resolved}`}
        defaultCenter={center}
        defaultZoom={zoom}
        colorScheme={resolved === 'dark' ? 'DARK' : 'LIGHT'}
        styles={resolved === 'dark' ? DARK_MAP_STYLES : undefined}
        // auto = one-finger page scroll on phones (two fingers pan the map),
        // direct panning on desktop. 'greedy' trapped the page on phones.
        gestureHandling="auto"
        mapTypeControl={false}
        streetViewControl={false}
        style={{ width: '100%', height }}
      >
        <HexLayer cells={cells} onSelect={onSelect} />
      </Map>
    </APIProvider>
  );
}
