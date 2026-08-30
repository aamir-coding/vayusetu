import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { EyeOff } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@vayusetu/ui-components';
import type { CorridorId } from '@vayusetu/shared-types';
import { useAuth } from '../hooks/useAuth';
import { useLiteMode } from '../hooks/useLiteMode';
import { corridorsApi, hotspotsApi } from '../lib/apiClient';
import { LiteModeTable } from './LiteModeTable';
import type { HotspotCellWithPosition } from '../mocks/fixtures';

const VIEW_W = 640;
const VIEW_H = 380;
const PAD = 40;

function confidenceColor(score: number): string {
  if (score >= 0.75) return '#B91C1C';
  if (score >= 0.5) return '#EA580C';
  if (score >= 0.25) return '#EAB308';
  return '#94A3B8';
}

export function HotspotMap() {
  const { getToken } = useAuth();
  const { liteMode } = useLiteMode();
  const [corridorId, setCorridorId] = React.useState<CorridorId>('ncr-airshed');

  const { data: corridorsData } = useQuery({
    queryKey: ['corridors'],
    queryFn: async () => corridorsApi.list(await getToken()),
  });

  const { data: hotspotData, isLoading } = useQuery({
    queryKey: ['hotspots', corridorId],
    queryFn: async () => hotspotsApi.list(await getToken(), corridorId),
  });

  // Mock-only: cells carry a synthesized lat/lng (see mocks/fixtures.ts) so
  // this screen has something to plot without packages/h3-utils existing
  // yet. Once that package lands, swap this cast for a real
  // `cellToLatLng(h3Index)` call — nothing else here needs to change.
  const cells = React.useMemo(() => (hotspotData?.cells ?? []) as HotspotCellWithPosition[], [hotspotData]);

  const projected = React.useMemo(() => {
    if (cells.length === 0) return [];
    const lats = cells.map((c) => c.lat);
    const lngs = cells.map((c) => c.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const latSpan = maxLat - minLat || 1;
    const lngSpan = maxLng - minLng || 1;
    return cells.map((cell) => ({
      cell,
      x: PAD + ((cell.lng - minLng) / lngSpan) * (VIEW_W - PAD * 2),
      // screen-space y is inverted relative to latitude
      y: VIEW_H - PAD - ((cell.lat - minLat) / latSpan) * (VIEW_H - PAD * 2),
    }));
  }, [cells]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">Hotspot Map</h1>
          <p className="text-sm text-slate-500">Fused hourly confidence grid — dashed ring marks a hidden hotspot</p>
        </div>
        <Select value={corridorId} onValueChange={(v) => setCorridorId(v)}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(corridorsData?.corridors ?? [{ id: 'ncr-airshed', name: 'Delhi-NCR Airshed' }, { id: 'mumbai-pune-corridor', name: 'Mumbai–Pune Industrial Corridor' }]).map(
              (c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : liteMode ? (
        <LiteModeTable cells={cells} />
      ) : (
        <div className="rounded-xl2 border border-slate-200 bg-white p-4">
          <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full" role="img" aria-label="Hotspot confidence map">
            <rect x={0} y={0} width={VIEW_W} height={VIEW_H} rx={12} fill="#F5F8F7" />
            {projected.map(({ cell, x, y }) => (
              <g key={cell.id} transform={`translate(${x}, ${y})`}>
                {cell.isHidden && (
                  <circle r={20} fill="none" stroke="#EFA22A" strokeWidth={2} strokeDasharray="4 3">
                    <animate attributeName="r" values="16;22;16" dur="3s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle r={10 + cell.hotspotConfidenceScore * 10} fill={confidenceColor(cell.hotspotConfidenceScore)} fillOpacity={0.85} />
                <title>
                  {cell.classification.replace(/_/g, ' ')} · {Math.round(cell.hotspotConfidenceScore * 100)}% confidence
                  {cell.isHidden ? ' · HIDDEN HOTSPOT' : ''}
                </title>
              </g>
            ))}
          </svg>

          <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <EyeOff className="h-3.5 w-3.5 text-accent-600" /> Dashed ring = hidden hotspot (no monitor within 3&nbsp;km)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: confidenceColor(0.9) }} /> High confidence
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: confidenceColor(0.1) }} /> Low confidence
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
