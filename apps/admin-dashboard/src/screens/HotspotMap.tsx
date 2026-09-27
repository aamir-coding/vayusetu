import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { EyeOff, X } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@vayusetu/ui-components';
import type { CorridorId, HotspotCell } from '@vayusetu/shared-types';
import { useAuth } from '../hooks/useAuth';
import { useLiteMode } from '../hooks/useLiteMode';
import { corridorsApi, hotspotsApi } from '../lib/apiClient';
import { confidenceColor, type HexDatum } from '../lib/hexGeo';
import { corridorView, DEFAULT_CORRIDORS } from '../lib/corridors';
import { HexMap } from '../components/HexMap';
import { LiteModeTable } from './LiteModeTable';

function CellDetail({ cell, onClose }: { cell: HotspotCell; onClose: () => void }) {
  const { getToken } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['hotspot-history', cell.h3Index],
    queryFn: async () => hotspotsApi.history(await getToken(), cell.h3Index, '7d'),
  });
  const series = React.useMemo(
    () =>
      [...(data?.points ?? [])]
        .sort((a, b) => a.timestampHour.localeCompare(b.timestampHour))
        .map((p) => ({ t: p.timestampHour.slice(5, 13).replace('T', ' '), score: Math.round(p.hotspotConfidenceScore * 100) })),
    [data],
  );
  const s = cell.contributingSignals;
  const rows: Array<[string, string | number | undefined]> = [
    ['Citizen reports', s.citizenReportCount],
    ['Avg citizen severity', s.avgCitizenSeverity?.toFixed(1)],
    ['Satellite AOD', s.satelliteAOD?.toFixed(2)],
    ['Satellite NO₂', s.satelliteNO2?.toFixed(2)],
    ['Fire detections', s.fireDetectionCount],
    ['Nearest monitor', s.nearestMonitorId],
    ['Δ AQI vs monitor', s.nearestMonitorDeltaAQI],
  ];
  return (
    <aside className="flex flex-col gap-3 rounded-xl2 border border-slate-200 bg-white p-4" aria-label="Selected cell">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-slate-500">{cell.h3Index}</p>
          <p className="text-lg font-bold capitalize text-ink">{cell.classification.replace(/_/g, ' ')}</p>
          <p className="text-sm text-slate-600">
            {Math.round(cell.hotspotConfidenceScore * 100)}% confidence
            {cell.isHidden && <span className="ml-2 font-semibold text-accent-600">· hidden hotspot</span>}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        {rows
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right font-medium text-ink">{v}</dd>
            </React.Fragment>
          ))}
      </dl>
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Last 7 days</p>
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : series.length < 2 ? (
          <p className="text-sm text-slate-500">Not enough scored hours yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={112}>
            <LineChart data={series}>
              <XAxis dataKey="t" hide />
              <YAxis domain={[0, 100]} width={28} tick={{ fontSize: 10 }} />
              <Tooltip formatter={(v) => [`${v}%`, 'confidence']} />
              <Line type="monotone" dataKey="score" stroke="#B91C1C" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="text-xs text-slate-400">Model {cell.modelVersion} · hour {cell.timestampHour.slice(0, 13).replace('T', ' ')} UTC</p>
    </aside>
  );
}

export function HotspotMap() {
  const { getToken } = useAuth();
  const { liteMode } = useLiteMode();
  const [corridorId, setCorridorId] = React.useState<CorridorId>('ncr-airshed');
  const [selected, setSelected] = React.useState<string | null>(null);

  const { data: corridorsData } = useQuery({
    queryKey: ['corridors'],
    queryFn: async () => corridorsApi.list(await getToken()),
  });

  const { data: hotspotData, isLoading } = useQuery({
    queryKey: ['hotspots', corridorId],
    queryFn: async () => hotspotsApi.list(await getToken(), corridorId),
    refetchInterval: 5 * 60_000, // the grid is rescored hourly; the fast path can land any time
  });

  const cells = React.useMemo(() => hotspotData?.cells ?? [], [hotspotData]);
  const selectedCell = cells.find((c) => c.h3Index === selected);
  const hiddenCount = cells.filter((c) => c.isHidden).length;
  const view = corridorView(corridorId);
  const hexes = React.useMemo<HexDatum[]>(
    () =>
      cells.map((c) => ({
        h3Index: c.h3Index,
        score: c.hotspotConfidenceScore,
        highlight: c.isHidden,
        label: `${c.classification.replace(/_/g, ' ')} · ${Math.round(c.hotspotConfidenceScore * 100)}% confidence${c.isHidden ? ' · HIDDEN HOTSPOT' : ''}`,
      })),
    [cells],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Hotspot Map</h1>
          <p className="text-sm text-slate-500">
            Fused hourly confidence grid · {cells.length} cells · {hiddenCount} hidden (no monitor within 3&nbsp;km)
          </p>
        </div>
        <Select
          value={corridorId}
          onValueChange={(v) => {
            setCorridorId(v);
            setSelected(null);
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(corridorsData?.corridors ?? DEFAULT_CORRIDORS).map(
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
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="overflow-hidden rounded-xl2 border border-slate-200 bg-white">
            <HexMap cells={hexes} onSelect={setSelected} center={view.center} zoom={view.zoom} mapKey={corridorId} />
            <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <EyeOff className="h-3.5 w-3.5 text-accent-600" /> Amber outline = hidden hotspot
              </span>
              {[0.9, 0.6, 0.3, 0.1].map((v) => (
                <span key={v} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: confidenceColor(v) }} /> ≥{Math.max(0, Math.floor(v * 4) * 25)}%
                </span>
              ))}
            </div>
          </div>
          {selectedCell ? (
            <CellDetail cell={selectedCell} onClose={() => setSelected(null)} />
          ) : (
            <aside className="rounded-xl2 border border-dashed border-slate-200 p-4 text-sm text-slate-500">
              Select a cell to see its signals and the last 7 days of scores.
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
