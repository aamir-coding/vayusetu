import * as React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { HotspotCell } from '@vayusetu/shared-types';
import { cn } from '@vayusetu/ui-components';

type SortKey = 'hotspotConfidenceScore' | 'timestampHour' | 'contributingSignals.citizenReportCount';

const COLUMNS: Array<{ key: SortKey | 'h3Index' | 'classification' | 'isHidden'; label: string; sortable: boolean }> = [
  { key: 'h3Index', label: 'H3 Cell', sortable: false },
  { key: 'classification', label: 'Classification', sortable: false },
  { key: 'hotspotConfidenceScore', label: 'Confidence', sortable: true },
  { key: 'isHidden', label: 'Hidden', sortable: false },
  { key: 'contributingSignals.citizenReportCount', label: 'Reports', sortable: true },
  { key: 'timestampHour', label: 'Updated', sortable: true },
];

/** Product Spec: "Admin Dashboard has a 'Lite Mode' plain-table fallback." Zero
 *  images, zero SVG geometry, zero animation — a plain HTML table an
 *  official on a throttled connection can render and scan quickly. */
export function LiteModeTable({ cells }: { cells: HotspotCell[] }) {
  const [sortKey, setSortKey] = React.useState<SortKey>('hotspotConfidenceScore');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc');

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sorted = React.useMemo(() => {
    const value = (cell: HotspotCell): number | string =>
      sortKey === 'contributingSignals.citizenReportCount' ? cell.contributingSignals.citizenReportCount : cell[sortKey];
    return [...cells].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [cells, sortKey, sortDir]);

  return (
    <div className="overflow-x-auto rounded-xl2 border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            {COLUMNS.map((col) => (
              <th key={col.key} className="px-4 py-2.5">
                {col.sortable ? (
                  <button type="button" className="flex items-center gap-1" onClick={() => toggleSort(col.key as SortKey)}>
                    {col.label}
                    {sortKey === col.key && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((cell) => (
            <tr key={cell.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
              <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{cell.h3Index}</td>
              <td className="px-4 py-2.5 capitalize text-slate-700">{cell.classification.replace(/_/g, ' ')}</td>
              <td className="px-4 py-2.5 text-slate-700">{Math.round(cell.hotspotConfidenceScore * 100)}%</td>
              <td className="px-4 py-2.5">
                {cell.isHidden && (
                  <span className={cn('rounded-full bg-accent-500/20 px-2 py-0.5 text-xs font-semibold text-accent-700')}>Hidden</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-slate-700">{cell.contributingSignals.citizenReportCount}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-slate-400">
                {new Date(cell.timestampHour).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
