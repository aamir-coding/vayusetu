import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Compass } from 'lucide-react';
import {
  Card,
  CardContent,
  GrapStageBadge,
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
import { corridorsApi, forecastsApi } from '../lib/apiClient';

export function ForecastView() {
  const { getToken } = useAuth();
  const { liteMode } = useLiteMode();
  const [corridorId, setCorridorId] = React.useState<CorridorId>('ncr-airshed');

  const { data: corridorsData } = useQuery({
    queryKey: ['corridors'],
    queryFn: async () => corridorsApi.list(await getToken()),
  });

  const { data: run, isLoading } = useQuery({
    queryKey: ['forecast', corridorId],
    queryFn: async () => forecastsApi.latest(await getToken(), corridorId),
  });

  const chartData = (run?.horizons ?? []).map((h) => ({
    horizon: `${h.horizonHours}h`,
    predictedAQI: h.predictedAQI,
    range: [h.confidenceInterval.lower, h.confidenceInterval.upper] as [number, number],
    grapStage: h.predictedGRAPStage,
    category: h.predictedAQICategory,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">72-Hour Forecast</h1>
          <p className="text-sm text-slate-500">Corridor AQI trajectory, scored every 6 hours</p>
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
        <Skeleton className="h-80 w-full" />
      ) : !run ? (
        <p className="text-sm text-slate-400">No forecast available for this corridor.</p>
      ) : (
        <>
          {liteMode ? (
            <div className="overflow-hidden rounded-xl2 border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5">Horizon</th>
                    <th className="px-4 py-2.5">Predicted AQI</th>
                    <th className="px-4 py-2.5">Range</th>
                    <th className="px-4 py-2.5">GRAP Stage</th>
                  </tr>
                </thead>
                <tbody>
                  {chartData.map((row) => (
                    <tr key={row.horizon} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-2.5 font-medium text-ink">{row.horizon}</td>
                      <td className="px-4 py-2.5">{row.predictedAQI}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-400">
                        {row.range[0]}–{row.range[1]}
                      </td>
                      <td className="px-4 py-2.5">
                        <GrapStageBadge stage={row.grapStage} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Card>
              <CardContent className="pt-5">
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="horizon" tick={{ fontSize: 12, fill: '#64748B' }} />
                    <YAxis tick={{ fontSize: 12, fill: '#64748B' }} />
                    <Tooltip
                      formatter={(value, name) => (name === 'range' ? undefined : [value, 'Predicted AQI'])}
                      labelFormatter={(label) => `+${label}`}
                    />
                    <Area dataKey="range" stroke="none" fill="#1F948C" fillOpacity={0.15} isAnimationActive={false} />
                    <Line type="monotone" dataKey="predictedAQI" stroke="#157B76" strokeWidth={2.5} dot={{ r: 5, fill: '#157B76' }} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>

                <div className="mt-4 grid grid-cols-3 gap-3">
                  {chartData.map((row) => (
                    <div key={row.horizon} className="rounded-lg bg-slate-50 p-3 text-center">
                      <p className="text-xs font-medium text-slate-400">+{row.horizon}</p>
                      <p className="mt-1 text-lg font-bold text-ink">{row.predictedAQI}</p>
                      <GrapStageBadge stage={row.grapStage} className="mt-1" />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="flex flex-col gap-2 pt-5">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                <Compass className="h-3.5 w-3.5" /> Key drivers
              </p>
              <ul className="list-inside list-disc space-y-1 text-sm text-slate-700">
                {run.keyDrivers.map((driver) => (
                  <li key={driver}>{driver}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
