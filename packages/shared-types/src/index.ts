// packages/shared-types/src/index.ts
//
// Canonical, single-source-of-truth TypeScript contracts for VayuSetu.
// Imported by every app in the monorepo — frontend, every backend service,
// and the ingestion jobs. No service or component redefines its own shape
// for a shared entity. See PRD_AND_ARCHITECTURE.md Section 4 for the
// governing rationale. THIS FILE IS VERBATIM FROM SECTION 4.1 — DO NOT
// DIVERGE WITHOUT A PR THAT EVERY CONSUMER'S CI RUNS AGAINST.

// ===================== Shared Primitives =====================

export type ISODateString = string;     // "2026-08-25T10:00:00.000Z"
export type BCP47LanguageTag = string;  // "hi-IN" | "pa-IN" | "mr-IN" | "en-IN" | ...
export type LGDStateCode = string;      // Local Government Directory state code
export type LGDDistrictCode = string;   // Local Government Directory district code
export type H3Index = string;           // H3 cell index (res 8 operational, res 6 federated)
export type CorridorId = string;        // e.g. "ncr-airshed" | "mumbai-pune-corridor"

export type UserRole =
  | 'citizen' | 'field_worker' | 'district_admin' | 'state_admin' | 'super_admin';

export type PollutionSourceType =
  | 'crop_residue_burning' | 'industrial_emission' | 'open_waste_burning'
  | 'vehicular_smog' | 'construction_dust' | 'no_visible_pollution' | 'indeterminate';

export type AQICategory =
  | 'good' | 'satisfactory' | 'moderate' | 'poor' | 'very_poor' | 'severe';

export type GRAPStage = 'none' | 'stage_1' | 'stage_2' | 'stage_3' | 'stage_4';

export type SubmissionStatus =
  | 'queued' | 'uploading' | 'pending_analysis' | 'analyzed' | 'failed' | 'flagged_for_review';

export type AlertType = 'hotspot' | 'forecast';
export type AlertSeverity = 'info' | 'watch' | 'warning' | 'critical';
export type AlertStatus = 'new' | 'acknowledged' | 'in_progress' | 'resolved' | 'dismissed';

export type ResourceType =
  | 'inspection_team' | 'anti_smog_gun' | 'water_sprinkler'
  | 'mobile_monitoring_van' | 'public_advisory' | 'other';

export type NotificationChannel = 'push' | 'sms' | 'whatsapp';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Jurisdiction {
  stateCode: LGDStateCode;
  districtCode?: LGDDistrictCode;   // omitted for state_admin and super_admin
}

// ===================== Core Entities =====================

export interface User {
  uid: string;
  phoneNumber?: string;
  email?: string;
  displayName: string;
  role: UserRole;
  preferredLanguage: BCP47LanguageTag;
  jurisdiction?: Jurisdiction;       // required for all roles except citizen/field_worker
  fcmTokens: string[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface Submission {
  id: string;
  userId: string;
  mediaType: 'photo' | 'photo_audio';
  photoStorageUrl: string;
  audioStorageUrl?: string;
  transcript?: string;
  geo: GeoPoint;
  h3Index: H3Index;
  jurisdiction: Jurisdiction;
  capturedAt: ISODateString;
  uploadedAt: ISODateString;
  status: SubmissionStatus;
  deviceMeta?: {
    platform: 'android' | 'ios' | 'web';
    appVersion: string;
    networkType?: '2g' | '3g' | '4g' | '5g' | 'wifi' | 'unknown';
  };
}

export interface AnalysisResult {
  submissionId: string;              // 1:1 with Submission.id
  sourceClassification: PollutionSourceType;
  severityEstimate: 1 | 2 | 3 | 4 | 5;
  skyOpacityScore: number;           // 0..1
  plumeDetected: boolean;
  visibilityMeters?: number;
  confidenceScore: number;           // 0..1
  needsHumanReview: boolean;
  reviewNote?: string;
  estimatedAQICategory?: AQICategory;
  crossValidation?: {
    nearestMonitorId?: string;
    nearestMonitorAQI?: number;
    satelliteAODAtCell?: number;
    agreementScore?: number;         // 0..1
  };
  advisory: {
    text: string;
    language: BCP47LanguageTag;
    audioStorageUrl?: string;
  };
  modelVersion: string;               // e.g. "gemini-3.7-flash@2026-07-14"
  rawResponseStorageUrl?: string;
  createdAt: ISODateString;
}

export interface HotspotCell {
  id: string;                         // `${h3Index}_${timestampHour}`
  h3Index: H3Index;
  corridorId: CorridorId;
  timestampHour: ISODateString;
  hotspotConfidenceScore: number;     // 0..1
  isHidden: boolean;
  classification: PollutionSourceType | 'mixed' | 'unknown';
  contributingSignals: {
    citizenReportCount: number;
    avgCitizenSeverity?: number;
    satelliteAOD?: number;
    satelliteNO2?: number;
    fireDetectionCount?: number;
    nearestMonitorId?: string;
    nearestMonitorDeltaAQI?: number;
  };
  modelVersion: string;
  createdAt: ISODateString;
}

export interface ForecastHorizonPoint {
  horizonHours: 24 | 48 | 72;
  predictedAQI: number;
  predictedAQICategory: AQICategory;
  predictedGRAPStage: GRAPStage;
  confidenceInterval: { lower: number; upper: number };
}

export interface ForecastRun {
  id: string;                         // `${corridorId}_${forecastRunTimestamp}`
  corridorId: CorridorId;
  forecastRunTimestamp: ISODateString;
  horizons: ForecastHorizonPoint[];
  keyDrivers: string[];
  modelVersion: string;
  createdAt: ISODateString;
}

export interface Alert {
  id: string;
  type: AlertType;
  sourceRef: string;                  // HotspotCell.id or ForecastRun.id
  corridorId: CorridorId;
  h3Index?: H3Index;
  severity: AlertSeverity;
  impliedGrapStage: GRAPStage;
  title: string;
  description: string;
  recommendedActions: string[];
  citedSignals: string[];
  publicAdvisory: string;
  assignedJurisdiction: Jurisdiction;
  assignedOfficerId?: string;
  status: AlertStatus;
  statusHistory: Array<{
    status: AlertStatus;
    byUserId: string;
    at: ISODateString;
    note?: string;
  }>;
  notificationsSent: Array<{
    channel: NotificationChannel;
    to: string;
    at: ISODateString;
    status: 'sent' | 'failed' | 'delivered';
  }>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface Corridor {
  id: CorridorId;
  name: string;
  states: LGDStateCode[];
  boundaryGeoJsonStorageUrl: string;
  population: number;
  monitoringStationIds: string[];
  grapFrameworkActive: boolean;
  grapThresholds?: Record<Exclude<GRAPStage, 'none'>, { aqiMin: number; aqiMax: number }>;
  createdAt: ISODateString;
}

export interface MonitoringStation {
  id: string;                         // CPCB/SPCB station code
  name: string;
  agency: 'CPCB' | 'SPCB' | 'other';
  geo: GeoPoint;
  h3Index: H3Index;
  isOfficial: boolean;
  lastReadingAt?: ISODateString;
}

export interface ResourceRequest {
  id: string;
  jurisdiction: Jurisdiction;
  resourceType: ResourceType;
  quantityNeeded: number;
  relatedAlertId?: string;
  status: 'open' | 'fulfilled' | 'cancelled';
  createdBy: string;
  createdAt: ISODateString;
}

export interface FederatedModel {
  id: string;
  sourceStateCode: LGDStateCode;
  modelType: 'hotspot' | 'forecast';
  vertexModelRegistryUri: string;
  version: string;
  trainingDataSummary: {
    recordCount: number;
    dateRangeStart: ISODateString;
    dateRangeEnd: ISODateString;
  };
  performanceMetrics: Record<string, number>;  // e.g. { auc: 0.87, mape: 12.4 }
  sharedAt: ISODateString;
  downloadCount: number;
}

// ===================== Standard API Envelope =====================

export type ApiErrorCode =
  | 'VALIDATION_ERROR' | 'UNAUTHORIZED' | 'FORBIDDEN_JURISDICTION'
  | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL_ERROR';

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

export interface Paginated<T> {
  items: T[];
  nextPageToken?: string;
  totalCount?: number;
}
