import { describe, expect, it } from 'vitest';
import { formatMetric, splitMetrics, versionLabel } from '../src/lib/modelMetrics';

describe('shared-model card metrics', () => {
  it('leads with the gate metric, never the micro-averaged headline', () => {
    // Live 30 Sep: hotspot v2 exported auPrc 0.936 (micro) next to the gate's 0.55.
    const m = splitMetrics('hotspot', { auPrc: 0.936, auRoc: 0.938, logLoss: 0.32, gate_auprc: 0.55, 'confidenceMetrics.x': 1 });
    expect(m.gate).toEqual({ key: 'gate_auprc', label: 'auPRC (hotspot class)', value: 0.55 });
    expect(m.headline.map((r) => r.key)).toEqual(['logLoss']);
    expect(m.rest.map((r) => r.key)).toEqual(['auPrc', 'auRoc', 'confidenceMetrics.x']);
  });

  it('forecast shows MAPE as the gate and error metrics as headlines, without repeating the gate', () => {
    const m = splitMetrics('forecast', { meanAbsolutePercentageError: 22.74, meanAbsoluteError: 23.3, rootMeanSquaredError: 34.9, rSquared: 0.43, gate_meanabsolutepercentageerror: 22.74 });
    expect(m.gate?.label).toBe('MAPE %');
    expect(m.headline.map((r) => r.label)).toEqual(['MAPE %', 'MAE (AQI)', 'RMSE (AQI)']);
    expect(m.rest.map((r) => r.key)).toEqual(['rSquared']);
  });

  it('versions are labelled once ("vv1" was a live bug)', () => {
    expect(versionLabel('v1')).toBe('v1');
    expect(versionLabel('2')).toBe('v2');
  });

  it('formats numbers compactly', () => {
    expect(formatMetric(22.741362)).toBe('22.74');
    expect(formatMetric(0.550021)).toBe('0.550');
    expect(formatMetric(539902)).toBe('539902');
  });
});
