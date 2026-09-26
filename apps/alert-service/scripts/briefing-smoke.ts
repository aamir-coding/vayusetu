// Live Pipeline C through the full guarded generator (Vertex AI, ADC).
//   GOOGLE_CLOUD_PROJECT=vayusetu-ncr-dev npx tsx scripts/briefing-smoke.ts
import type { BriefingInput } from '../src/domain/briefing.js';
import { templateBriefingGenerator } from '../src/domain/briefing.js';
import { createGeminiBriefingGenerator } from '../src/gemini/geminiBriefingGenerator.js';
import { createPipelineCModelCall } from '../src/gemini/modelCall.js';

const NCR = {
  id: 'ncr-airshed', name: 'Delhi-NCR Airshed', states: ['DL', 'HR', 'UP', 'RJ'], boundaryGeoJsonStorageUrl: 'gs://x',
  population: 46_000_000, monitoringStationIds: [], grapFrameworkActive: true, createdAt: '2026-01-01T00:00:00.000Z',
  grapThresholds: { stage_1: { aqiMin: 201, aqiMax: 300 }, stage_2: { aqiMin: 301, aqiMax: 400 }, stage_3: { aqiMin: 401, aqiMax: 450 }, stage_4: { aqiMin: 451, aqiMax: 500 } },
};
const cell = {
  id: '883da1ab2bfffff_2026-11-03T02', h3Index: '883da1ab2bfffff', corridorId: 'ncr-airshed', timestampHour: '2026-11-03T02:00:00.000Z',
  hotspotConfidenceScore: 0.92, isHidden: true, classification: 'open_waste_burning' as const,
  contributingSignals: { citizenReportCount: 14, avgCitizenSeverity: 4.2, satelliteAOD: 0.61, fireDetectionCount: 3, nearestMonitorId: 'anand-vihar-delhi-dpcc', nearestMonitorDeltaAQI: 140 },
  modelVersion: 'hs-v1', createdAt: '2026-11-03T02:05:00.000Z',
};
const input: BriefingInput = {
  kind: 'hotspot', cell, corridor: NCR, jurisdiction: { stateCode: 'DL', districtCode: 'DL-EAST' }, severity: 'critical',
  history: [{ ...cell, id: 'prev', timestampHour: '2026-11-03T01:00:00.000Z', hotspotConfidenceScore: 0.66, contributingSignals: { citizenReportCount: 3 } }],
};
const logger = { info: (o: object, m: string) => console.log('INFO', m, JSON.stringify(o)), warn: (o: object, m: string) => console.log('WARN', m, JSON.stringify(o)) };
const gen = createGeminiBriefingGenerator({
  callModel: createPipelineCModelCall({ project: process.env.GOOGLE_CLOUD_PROJECT! }),
  fallback: templateBriefingGenerator, timeoutMs: 60_000, logger,
  onOutcome: (o, d) => console.log('OUTCOME', o, JSON.stringify(d)),
});
const t0 = Date.now();
const briefing = await gen.generate(input);
console.log(`\n(${Date.now() - t0} ms)`, JSON.stringify(briefing, null, 2));
