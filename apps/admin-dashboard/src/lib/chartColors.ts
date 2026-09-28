import * as React from 'react';
import { useTheme } from '@vayusetu/ui-components';

/**
 * Chart chrome for the current theme. Recharts writes colours into SVG
 * attributes, where CSS variables don't resolve, so pick concrete values.
 * Data colours (AQI, GRAP, confidence) stay the same in both themes.
 */
export function useChartColors() {
  const { resolved } = useTheme();
  return React.useMemo(() => {
    const dark = resolved === 'dark';
    return {
      grid: dark ? '#2A3942' : '#E2E8F0',
      axis: dark ? '#98A7B2' : '#64748B',
      line: dark ? '#3FB3AA' : '#157B76',
      band: dark ? '#3FB3AA' : '#1F948C',
      tooltip: {
        contentStyle: {
          background: dark ? '#111A21' : '#FFFFFF',
          border: `1px solid ${dark ? '#2A3942' : '#E2E8F0'}`,
          borderRadius: 10,
          color: dark ? '#E6EEEF' : '#0E2224',
          fontSize: 12,
        },
        labelStyle: { color: dark ? '#98A7B2' : '#64748B' },
      },
    };
  }, [resolved]);
}
