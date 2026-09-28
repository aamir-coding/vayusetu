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
import { useTranslation } from 'react-i18next';
import type { CorridorId, HotspotCell } from '@vayusetu/shared-types';
import { useAuth } from '../hooks/useAuth';
import { useLiteMode } from '../hooks/useLiteMode';
import { useChartColors } from '../lib/chartColors';
import { corridorsApi, hotspotsApi } from '../lib/apiClient';
import { confidenceColor, type HexDatum } from '../lib/hexGeo';
import { corridorView, DEFAULT_CORRIDORS } from '../lib/corridors';
import { HexMap } from '../components/HexMap';
import { LiteModeTable } from './LiteModeTable';

function CellDetail({ cell, onClose }: { cell: HotspotCell; onClose: () => void }) {
  const colors = useChartColors();
  const { t } = useTranslation();
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
    [t('hotspots.signals.citizenReports'), s.citizenReportCount],
    [t('hotspots.signals.avgSeverity'), s.avgCitizenSeverity?.toFixed(1)],
    [t('hotspots.signals.aod'), s.satelliteAOD?.toFixed(2)],
    [t('hotspots.signals.no2'), s.satelliteNO2?.toFixed(2)],
    [t('hotspots.signals.fires'), s.fireDetectionCount],
    [t('hotspots.signals.nearestMonitor'), s.nearestMonitorId],
    [t('hotspots.signals.deltaAqi'), s.nearestMonitorDeltaAQI],
  ];
  return (
    <aside className="flex flex-col gap-3 rounded-xl2 border border-slate-200 bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-slate-500">{cell.h3Index}</p>
          <p className="text-lg font-bold text-ink">{t(`source.${cell.classification}`)}</p>
          <p className="text-sm text-slate-600">
            {t('hotspots.confidence', { pct: Math.round(cell.hotspotConfidenceScore * 100) })}
            {cell.isHidden && <span className="ml-2 font-semibold text-accent-600">· {t('hotspots.hiddenHotspot')}</span>}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded p-1 text-slate-400 hover:bg-slate-100">
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
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('hotspots.last7Days')}</p>
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : series.length < 2 ? (
          <p className="text-sm text-slate-500">{t('hotspots.notEnoughHistory')}</p>
        ) : (
          <ResponsiveContainer width="100%" height={112}>
            <LineChart data={series}>
              <XAxis dataKey="t" hide />
              <YAxis domain={[0, 100]} width={28} tick={{ fontSize: 10, fill: colors.axis }} stroke={colors.grid} />
              <Tooltip formatter={(v) => [`${v}%`, 'confidence']} {...colors.tooltip} />
              <Line type="monotone" dataKey="score" stroke="#B91C1C" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="text-xs text-slate-400">{t('hotspots.modelHour', { model: cell.modelVersion, hour: cell.timestampHour.slice(0, 13).replace('T', ' ') })}</p>
    </aside>
  );
}

export function HotspotMap() {
  const { t } = useTranslation();
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
  const detailRef = React.useRef<HTMLDivElement>(null);
  // Phones stack the detail under the map: bring it into view on a tap.
  React.useEffect(() => {
    if (selected && window.matchMedia('(max-width: 1023px)').matches) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected]);
  const selectedCell = cells.find((c) => c.h3Index === selected);
  const hiddenCount = cells.filter((c) => c.isHidden).length;
  const view = corridorView(corridorId);
  const hexes = React.useMemo<HexDatum[]>(
    () =>
      cells.map((c) => ({
        h3Index: c.h3Index,
        score: c.hotspotConfidenceScore,
        highlight: c.isHidden,
        label: `${t(`source.${c.classification}`)} · ${t('hotspots.confidence', { pct: Math.round(c.hotspotConfidenceScore * 100) })}${c.isHidden ? ` · ${t('hotspots.hiddenHotspot')}` : ''}`,
      })),
    [cells, t],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div>
          <h1 className="hidden text-xl font-bold text-ink lg:block">{t('hotspots.title')}</h1>
          <p className="text-sm text-slate-500">
            {t('hotspots.subtitle', { cells: cells.length, hidden: hiddenCount })}
          </p>
        </div>
        <Select
          value={corridorId}
          onValueChange={(v) => {
            setCorridorId(v);
            setSelected(null);
          }}
        >
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(corridorsData?.corridors ?? DEFAULT_CORRIDORS).map(
              (c) => (
                <SelectItem key={c.id} value={c.id}>
                  {t(`corridor.${c.id}`, { defaultValue: c.name })}
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
          <div className="overflow-hidden rounded-xl2 border border-slate-200 bg-surface">
            <HexMap cells={hexes} onSelect={setSelected} center={view.center} zoom={view.zoom} mapKey={corridorId} height="min(32rem, 62svh)" />
            <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <EyeOff className="h-3.5 w-3.5 text-accent-600" /> {t('hotspots.hiddenLegend')}
              </span>
              {[0.9, 0.6, 0.3, 0.1].map((v) => (
                <span key={v} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: confidenceColor(v) }} /> ≥{Math.max(0, Math.floor(v * 4) * 25)}%
                </span>
              ))}
            </div>
          </div>
          {selectedCell ? (
            <div ref={detailRef} className="scroll-mt-20 animate-in fade-in-0 slide-in-from-bottom-2 duration-300 lg:slide-in-from-right-2">
              <CellDetail cell={selectedCell} onClose={() => setSelected(null)} />
            </div>
          ) : (
            <aside className="rounded-xl2 border border-dashed border-slate-200 p-4 text-sm text-slate-500">
              {t('hotspots.selectCell')}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
