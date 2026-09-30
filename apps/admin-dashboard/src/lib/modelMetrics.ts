/**
 * What a shared-model card shows. Vertex returns dozens of flattened metrics
 * (confusion-matrix cells, per-threshold curves); dumping them all buried the
 * one that matters and led with the hotspot model's micro-averaged auPRC
 * (0.94) -- the exact figure its model card rejects in favour of the
 * positive-class gate metric (0.55). The card now leads with the gate metric,
 * then a few headline metrics per model type; the rest stay one click away.
 */
export interface MetricRow {
  key: string;
  label: string;
  value: number;
}

const GATE_LABEL: Record<string, string> = {
  gate_auprc: 'auPRC (hotspot class)',
  gate_meanabsolutepercentageerror: 'MAPE %',
};

const HEADLINE: Record<string, Array<[string, string]>> = {
  forecast: [
    ['meanAbsolutePercentageError', 'MAPE %'],
    ['meanAbsoluteError', 'MAE (AQI)'],
    ['rootMeanSquaredError', 'RMSE (AQI)'],
  ],
  hotspot: [['logLoss', 'Log loss']],
};

/** "v1" or "1" -> "v1" (the API already prefixes some versions). */
export function versionLabel(version: string): string {
  return /^v/i.test(version) ? version : `v${version}`;
}

export function splitMetrics(
  modelType: string,
  metrics: Record<string, number>,
): { gate?: MetricRow; headline: MetricRow[]; rest: MetricRow[] } {
  const gateKey = Object.keys(metrics).find((k) => k.startsWith('gate_'));
  const gate = gateKey
    ? { key: gateKey, label: GATE_LABEL[gateKey] ?? gateKey.slice('gate_'.length), value: metrics[gateKey]! }
    : undefined;
  const headline = (HEADLINE[modelType] ?? [])
    .filter(([k]) => typeof metrics[k] === 'number' && k !== gateKey)
    .map(([key, label]) => ({ key, label, value: metrics[key]! }));
  const shown = new Set([gateKey, ...headline.map((m) => m.key)]);
  const rest = Object.entries(metrics)
    .filter(([k]) => !shown.has(k))
    .map(([key, value]) => ({ key, label: key, value }));
  return { gate, headline, rest };
}

/** Compact, human number: 22.7414 -> "22.74", 0.550021 -> "0.550". */
export function formatMetric(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
}
