import type {
  Alert,
  Corridor,
  FederatedModel,
  ForecastRun,
  HotspotCell,
  Jurisdiction,
  ResourceRequest,
} from '@vayusetu/shared-types';

/**
 * `HotspotCell` (the canonical contract type) has no lat/lng — position is
 * implied by `h3Index`, resolved via Engineer 4's `packages/h3-utils`
 * (real `h3-js`, not built yet). Reimplementing H3-to-latLng here would be
 * scope creep into another engineer's package for a mock-data concern.
 * Instead this mock-only type pairs each fixture cell with a synthesized
 * lat/lng purely so `HotspotMap` has something to plot; production swaps
 * this for `cellToLatLng()` once `h3-utils` lands, with no change to the
 * component's props shape.
 */
export interface HotspotCellWithPosition extends HotspotCell {
  lat: number;
  lng: number;
}

const DL_CENTRAL: Jurisdiction = { stateCode: 'DL', districtCode: 'DL-CENTRAL' };
const DL_STATE: Jurisdiction = { stateCode: 'DL' };

/** Mirrors the two personas in `hooks/useAuth.tsx` — handlers.ts uses this
 *  to enforce the same server-side jurisdiction filtering a real backend
 *  would (§4.2: "never client-filtered"), even in mock mode. */
export const mockSessionsByUid: Record<string, { role: string; jurisdiction: Jurisdiction }> = {
  'mock-deshmukh': { role: 'district_admin', jurisdiction: DL_CENTRAL },
  'mock-iyer': { role: 'state_admin', jurisdiction: DL_STATE },
};

export const corridors: Corridor[] = [
  {
    id: 'ncr-airshed',
    name: 'Delhi-NCR Airshed',
    states: ['DL', 'HR', 'UP', 'RJ'],
    boundaryGeoJsonStorageUrl: 'https://storage.mock.vayusetu.local/corridors/ncr-airshed.geojson',
    population: 46_000_000,
    monitoringStationIds: ['DL-DPCC-014', 'DL-DPCC-021', 'HR-SPCB-004'],
    grapFrameworkActive: true,
    grapThresholds: {
      stage_1: { aqiMin: 201, aqiMax: 300 },
      stage_2: { aqiMin: 301, aqiMax: 400 },
      stage_3: { aqiMin: 401, aqiMax: 450 },
      stage_4: { aqiMin: 451, aqiMax: 500 },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'mumbai-pune-corridor',
    name: 'Mumbai–Pune Industrial Corridor',
    states: ['MH'],
    boundaryGeoJsonStorageUrl: 'https://storage.mock.vayusetu.local/corridors/mumbai-pune-corridor.geojson',
    population: 31_000_000,
    monitoringStationIds: ['MH-MPCB-009'],
    grapFrameworkActive: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

export const hotspotCells: HotspotCellWithPosition[] = [
  {
    id: '8a1fb46622dffff_2026-08-29T06',
    h3Index: '8a1fb46622dffff',
    corridorId: 'ncr-airshed',
    timestampHour: '2026-08-29T06:00:00.000Z',
    hotspotConfidenceScore: 0.91,
    isHidden: true,
    classification: 'open_waste_burning',
    contributingSignals: { citizenReportCount: 14, avgCitizenSeverity: 4.1, satelliteAOD: 0.71, fireDetectionCount: 2, satelliteNO2: 1.4 },
    modelVersion: 'hotspot-confidence@mock',
    createdAt: '2026-08-29T06:05:00.000Z',
    lat: 28.671,
    lng: 77.312,
  },
  {
    id: '8a1fb466227ffff_2026-08-29T06',
    h3Index: '8a1fb466227ffff',
    corridorId: 'ncr-airshed',
    timestampHour: '2026-08-29T06:00:00.000Z',
    hotspotConfidenceScore: 0.64,
    isHidden: false,
    classification: 'vehicular_smog',
    contributingSignals: { citizenReportCount: 6, avgCitizenSeverity: 2.8, satelliteAOD: 0.44, nearestMonitorId: 'DL-DPCC-014', nearestMonitorDeltaAQI: 12 },
    modelVersion: 'hotspot-confidence@mock',
    createdAt: '2026-08-29T06:05:00.000Z',
    lat: 28.632,
    lng: 77.219,
  },
  {
    id: '8a1fb4670c7ffff_2026-08-29T06',
    h3Index: '8a1fb4670c7ffff',
    corridorId: 'ncr-airshed',
    timestampHour: '2026-08-29T06:00:00.000Z',
    hotspotConfidenceScore: 0.83,
    isHidden: true,
    classification: 'crop_residue_burning',
    contributingSignals: { citizenReportCount: 3, avgCitizenSeverity: 3.5, satelliteAOD: 0.58, fireDetectionCount: 9 },
    modelVersion: 'hotspot-confidence@mock',
    createdAt: '2026-08-29T06:05:00.000Z',
    lat: 28.9,
    lng: 76.95,
  },
  {
    id: '8a1fb469ab7ffff_2026-08-29T06',
    h3Index: '8a1fb469ab7ffff',
    corridorId: 'ncr-airshed',
    timestampHour: '2026-08-29T06:00:00.000Z',
    hotspotConfidenceScore: 0.29,
    isHidden: false,
    classification: 'no_visible_pollution',
    contributingSignals: { citizenReportCount: 2, avgCitizenSeverity: 1.2, satelliteAOD: 0.18 },
    modelVersion: 'hotspot-confidence@mock',
    createdAt: '2026-08-29T06:05:00.000Z',
    lat: 28.55,
    lng: 77.09,
  },
  {
    id: '8a3f6a1122dffff_2026-08-29T06',
    h3Index: '8a3f6a1122dffff',
    corridorId: 'mumbai-pune-corridor',
    timestampHour: '2026-08-29T06:00:00.000Z',
    hotspotConfidenceScore: 0.77,
    isHidden: true,
    classification: 'industrial_emission',
    contributingSignals: { citizenReportCount: 5, avgCitizenSeverity: 3.9, satelliteAOD: 0.52, satelliteNO2: 1.9 },
    modelVersion: 'hotspot-confidence@mock',
    createdAt: '2026-08-29T06:05:00.000Z',
    lat: 19.05,
    lng: 73.02,
  },
];

export const alerts: Alert[] = [
  {
    id: 'alert-1001',
    type: 'hotspot',
    sourceRef: hotspotCells[0]!.id,
    corridorId: 'ncr-airshed',
    h3Index: hotspotCells[0]!.h3Index,
    severity: 'critical',
    impliedGrapStage: 'stage_2',
    title: 'Hidden hotspot: open waste burning, East Delhi',
    description:
      'Citizen reports up 4x in the last 3 hours; satellite AOD 0.71, 2.6x the 30-day median for this cell; no official monitor within 3 km.',
    recommendedActions: ['Dispatch inspection team', 'Issue localized public advisory', 'Mechanized road sweeping within 1 km'],
    citedSignals: ['contributingSignals.citizenReportCount', 'contributingSignals.satelliteAOD', 'isHidden'],
    publicAdvisory: 'Avoid outdoor activity near East Delhi for the next few hours; air quality is very poor.',
    assignedJurisdiction: DL_CENTRAL,
    status: 'new',
    statusHistory: [{ status: 'new', byUserId: 'system', at: '2026-08-29T06:06:00.000Z' }],
    notificationsSent: [{ channel: 'push', to: 'mock-deshmukh', at: '2026-08-29T06:06:05.000Z', status: 'delivered' }],
    createdAt: '2026-08-29T06:06:00.000Z',
    updatedAt: '2026-08-29T06:06:00.000Z',
  },
  {
    id: 'alert-1002',
    type: 'forecast',
    sourceRef: 'ncr-airshed_2026-08-29T00',
    corridorId: 'ncr-airshed',
    severity: 'warning',
    impliedGrapStage: 'stage_1',
    title: '48h forecast crosses Stage I threshold, NCR Airshed',
    description:
      'AQI forecast to reach 268 within 48 hours, driven by declining boundary-layer height and rising harvest-season fire counts upwind.',
    recommendedActions: ['Pre-position water sprinklers', 'Notify construction sites of possible Stage I restrictions'],
    citedSignals: ['horizons[1].predictedAQI', 'keyDrivers'],
    publicAdvisory: 'Air quality is expected to worsen over the next two days; sensitive groups should plan accordingly.',
    assignedJurisdiction: DL_STATE,
    status: 'acknowledged',
    statusHistory: [
      { status: 'new', byUserId: 'system', at: '2026-08-28T18:00:00.000Z' },
      { status: 'acknowledged', byUserId: 'mock-iyer', at: '2026-08-28T18:40:00.000Z', note: 'Coordinating with DL-CENTRAL' },
    ],
    notificationsSent: [{ channel: 'push', to: 'mock-iyer', at: '2026-08-28T18:00:05.000Z', status: 'delivered' }],
    createdAt: '2026-08-28T18:00:00.000Z',
    updatedAt: '2026-08-28T18:40:00.000Z',
  },
  {
    id: 'alert-1003',
    type: 'hotspot',
    sourceRef: hotspotCells[2]!.id,
    corridorId: 'ncr-airshed',
    h3Index: hotspotCells[2]!.h3Index,
    severity: 'warning',
    impliedGrapStage: 'stage_1',
    title: 'Hidden hotspot: crop residue burning, NW periphery',
    description: 'VIIRS/MODIS fire detections (9) with satellite AOD 0.58; sparse citizen coverage consistent with a rural monitor-blind cell.',
    recommendedActions: ['Alert SPCB field team for ground verification', 'Cross-notify Haryana SPCB (upwind)'],
    citedSignals: ['contributingSignals.fireDetectionCount', 'isHidden'],
    publicAdvisory: 'Smoke may drift into nearby residential areas this evening.',
    assignedJurisdiction: DL_CENTRAL,
    status: 'in_progress',
    statusHistory: [
      { status: 'new', byUserId: 'system', at: '2026-08-29T05:10:00.000Z' },
      { status: 'acknowledged', byUserId: 'mock-deshmukh', at: '2026-08-29T05:22:00.000Z' },
      { status: 'in_progress', byUserId: 'mock-deshmukh', at: '2026-08-29T05:40:00.000Z', note: 'Field team dispatched' },
    ],
    notificationsSent: [{ channel: 'sms', to: '+91-98xxxxxx14', at: '2026-08-29T05:10:05.000Z', status: 'sent' }],
    createdAt: '2026-08-29T05:10:00.000Z',
    updatedAt: '2026-08-29T05:40:00.000Z',
  },
  {
    id: 'alert-1004',
    type: 'hotspot',
    sourceRef: 'mock-cell-4_2026-08-28T14',
    corridorId: 'ncr-airshed',
    severity: 'info',
    impliedGrapStage: 'none',
    title: 'Elevated vehicular smog, Central Delhi arterial roads',
    description: 'Moderate citizen report volume during evening peak traffic; nearest monitor agrees within 1 AQI category.',
    recommendedActions: ['Monitor — no action required yet'],
    citedSignals: ['contributingSignals.citizenReportCount', 'contributingSignals.nearestMonitorDeltaAQI'],
    publicAdvisory: 'Air quality is moderate near main roads during rush hour.',
    assignedJurisdiction: DL_CENTRAL,
    status: 'resolved',
    statusHistory: [
      { status: 'new', byUserId: 'system', at: '2026-08-28T14:00:00.000Z' },
      { status: 'resolved', byUserId: 'mock-deshmukh', at: '2026-08-28T19:00:00.000Z', note: 'Cleared with evening traffic' },
    ],
    notificationsSent: [],
    createdAt: '2026-08-28T14:00:00.000Z',
    updatedAt: '2026-08-28T19:00:00.000Z',
  },
  {
    id: 'alert-1005',
    type: 'hotspot',
    sourceRef: hotspotCells[4]!.id,
    corridorId: 'mumbai-pune-corridor',
    h3Index: hotspotCells[4]!.h3Index,
    severity: 'critical',
    impliedGrapStage: 'none',
    title: 'Hidden hotspot: industrial emission, Thane belt',
    description: 'Satellite NO2 column 1.9x the 30-day median; 5 citizen reports in 2 hours; no official monitor within 3 km.',
    recommendedActions: ['Dispatch inspection team', 'Cross-check against registered industrial units in this cell'],
    citedSignals: ['contributingSignals.satelliteNO2', 'isHidden'],
    publicAdvisory: 'Residents near the Thane industrial belt should limit outdoor exposure this evening.',
    assignedJurisdiction: { stateCode: 'MH', districtCode: 'MH-THANE' },
    status: 'new',
    statusHistory: [{ status: 'new', byUserId: 'system', at: '2026-08-29T06:10:00.000Z' }],
    notificationsSent: [],
    createdAt: '2026-08-29T06:10:00.000Z',
    updatedAt: '2026-08-29T06:10:00.000Z',
  },
];

export const forecastRuns: Record<string, ForecastRun> = {
  'ncr-airshed': {
    id: 'ncr-airshed_2026-08-29T00',
    corridorId: 'ncr-airshed',
    forecastRunTimestamp: '2026-08-29T00:00:00.000Z',
    horizons: [
      { horizonHours: 24, predictedAQI: 232, predictedAQICategory: 'poor', predictedGRAPStage: 'none', confidenceInterval: { lower: 210, upper: 255 } },
      { horizonHours: 48, predictedAQI: 268, predictedAQICategory: 'poor', predictedGRAPStage: 'stage_1', confidenceInterval: { lower: 240, upper: 296 } },
      { horizonHours: 72, predictedAQI: 312, predictedAQICategory: 'very_poor', predictedGRAPStage: 'stage_2', confidenceInterval: { lower: 270, upper: 350 } },
    ],
    keyDrivers: ['Declining boundary-layer height', 'Rising Punjab/Haryana fire counts', 'Low wind speed forecast'],
    modelVersion: 'aqi-forecast@mock',
    createdAt: '2026-08-29T00:05:00.000Z',
  },
  'mumbai-pune-corridor': {
    id: 'mumbai-pune-corridor_2026-08-29T00',
    corridorId: 'mumbai-pune-corridor',
    forecastRunTimestamp: '2026-08-29T00:00:00.000Z',
    horizons: [
      { horizonHours: 24, predictedAQI: 118, predictedAQICategory: 'moderate', predictedGRAPStage: 'none', confidenceInterval: { lower: 100, upper: 136 } },
      { horizonHours: 48, predictedAQI: 124, predictedAQICategory: 'moderate', predictedGRAPStage: 'none', confidenceInterval: { lower: 104, upper: 144 } },
      { horizonHours: 72, predictedAQI: 109, predictedAQICategory: 'moderate', predictedGRAPStage: 'none', confidenceInterval: { lower: 90, upper: 128 } },
    ],
    keyDrivers: ['Onshore coastal breeze expected to hold', 'Stable industrial emission baseline'],
    modelVersion: 'aqi-forecast@mock',
    createdAt: '2026-08-29T00:05:00.000Z',
  },
};

export const resourceRequests: ResourceRequest[] = [
  {
    id: 'res-2001',
    jurisdiction: DL_CENTRAL,
    resourceType: 'anti_smog_gun',
    quantityNeeded: 2,
    relatedAlertId: 'alert-1001',
    status: 'open',
    createdBy: 'mock-deshmukh',
    createdAt: '2026-08-29T06:20:00.000Z',
  },
  {
    id: 'res-2002',
    jurisdiction: { stateCode: 'HR', districtCode: 'HR-JHAJJAR' },
    resourceType: 'mobile_monitoring_van',
    quantityNeeded: 1,
    status: 'fulfilled',
    createdBy: 'mock-haryana-admin',
    createdAt: '2026-08-27T10:00:00.000Z',
  },
];

export const federatedModels: FederatedModel[] = [
  {
    id: 'fed-model-hr-hotspot-v3',
    sourceStateCode: 'HR',
    modelType: 'hotspot',
    vertexModelRegistryUri: 'projects/vayusetu-hr/locations/asia-south1/models/hotspot-v3',
    version: '3.1.0',
    trainingDataSummary: { recordCount: 48_200, dateRangeStart: '2026-06-01T00:00:00.000Z', dateRangeEnd: '2026-08-20T00:00:00.000Z' },
    performanceMetrics: { auc: 0.89, precision: 0.81, recall: 0.77 },
    sharedAt: '2026-08-28T02:00:00.000Z',
    downloadCount: 3,
  },
  {
    id: 'fed-model-up-forecast-v2',
    sourceStateCode: 'UP',
    modelType: 'forecast',
    vertexModelRegistryUri: 'projects/vayusetu-up/locations/asia-south1/models/forecast-v2',
    version: '2.4.0',
    trainingDataSummary: { recordCount: 61_500, dateRangeStart: '2026-05-15T00:00:00.000Z', dateRangeEnd: '2026-08-25T00:00:00.000Z' },
    performanceMetrics: { mape24h: 9.8, mape48h: 14.2, mape72h: 19.1 },
    sharedAt: '2026-08-27T02:00:00.000Z',
    downloadCount: 1,
  },
];
