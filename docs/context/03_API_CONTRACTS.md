# VayuSetu — API Contracts & Shared Types
> Source: PRD §4 · Steward: Engineer 2 — explicit in the PRD: `packages/shared-types` is the first PR merged on the project, before any other app code · **This file is canonical.** If code and this file disagree, that's a bug in one of them — flag it, don't silently trust either.

## Why this file is different from the rest
Every other file in this knowledge base is reference material. This one is closer to a contract: `packages/shared-types/src/index.ts` in the actual repo must stay byte-identical in shape to §4.1 below. A breaking change here without a corresponding PR to `packages/shared-types` is exactly the silent-runtime-mismatch failure mode this whole document structure exists to prevent.

## 4.1 — Core TypeScript Interfaces (canonical, `packages/shared-types/src/index.ts`)

```typescript
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
```

## 4.2 — REST API Contracts

**Service ownership** (routing: `packages/config/api-routes.json`, same map for the Vite dev proxy and Firebase Hosting rewrites): `submission-service` — Users, Submissions, Analysis, Corridors, Resource Coordination · `alert-service` — Alerts · `hotspot-service` — Hotspots · `forecast-service` — Forecasts · `federation-service` — Federation. `analysis-service` has no public routes (Pub/Sub worker). **24 endpoints** (23 + `POST /submissions/upload-url`).

**Conventions (apply to every endpoint, stated once):**
- Base path: `https://api.vayusetu.gov.in/api/v1` (per-state deployments use a subdomain, e.g. `api-hr.vayusetu.gov.in`, same contract).
- Auth: `Authorization: Bearer <Firebase ID token>` on **every** endpoint — no unauthenticated endpoint exists, including citizen submission, because jurisdiction-correct routing requires a resolvable identity.
- Errors use the `ApiError` envelope: `400` VALIDATION_ERROR · `401` UNAUTHORIZED · `403` FORBIDDEN_JURISDICTION · `404` NOT_FOUND · `409` CONFLICT · `429` RATE_LIMITED · `500` INTERNAL_ERROR.
- List endpoints accept `?pageSize` (default 20, max 100) + `?pageToken`, return `Paginated<T>`.
- `FORBIDDEN_JURISDICTION` fires whenever an official attempts to read/act outside their `User.jurisdiction` — enforced identically at the API layer **and** in Firestore security rules (defense in depth, not either/or).

### Users
- **`POST /users/register`** — Auth: any authenticated Firebase user, first call post-signup. Request: `{ displayName, preferredLanguage, role: 'citizen' | 'field_worker' }` *(district_admin+ accounts are provisioned out-of-band by a super_admin, never self-registered)*. Response `201`: `User`. Errors: `400`, `401`, `409` (profile exists).
- **`GET /users/me`** — Auth: any authenticated user. Response `200`: `User`. Errors: `401`, `404`.
- **`PATCH /users/me`** — Auth: any authenticated user. Request: `Partial<Pick<User, 'displayName' | 'preferredLanguage' | 'fcmTokens'>>`. Response `200`: `User`. Errors: `400`, `401`.

### Submissions
- **`POST /submissions/upload-url`** — Auth: citizen, field_worker (registered). Request: `{ kind: 'photo' | 'audio'; contentType: string }` (photo: image/jpeg, image/png, image/webp; audio: audio/webm, audio/ogg, audio/mp4, audio/mpeg, audio/wav; parameters such as `;codecs=opus` allowed). Response `200`: `{ uploadUrl: string; storageUrl: string; expiresAt: ISODateString }` — client PUTs the blob to `uploadUrl` with the identical `Content-Type` within 15 min, then passes `storageUrl` (`gs://…`) to `POST /submissions`, which rejects URLs not issued to the caller. Errors: `400`, `401`, `403`, `429`.
- **`POST /submissions`** — Auth: citizen, field_worker. Request: `{ mediaType, photoStorageUrl, audioStorageUrl?, geo, capturedAt, deviceMeta? }` *(media uploads client-side to Cloud Storage via signed URL first; this endpoint registers the resulting metadata)*. Response `202`: `{ submission: Submission }` — `202` because analysis is async, `status` starts `'queued'`. Errors: `400`, `401`, `403` (official callers), `429`, `500` (jurisdiction temporarily unresolvable — client retries).
- **`GET /submissions/:id`** — Auth: owner, or any official whose jurisdiction contains it. Response `200`: `{ submission: Submission; analysis: AnalysisResult | null }`. Errors: `401`, `403`, `404`.
- **`GET /submissions`** — Auth: any authenticated user (citizens/field workers see only their own; officials see their jurisdiction). Query: `?userId=&status=&h3Index=&pageSize=&pageToken=`. Response `200`: `Paginated<Submission>`. Errors: `401`.
- **`POST /submissions/:id/retry-analysis`** — Auth: owner, or district_admin+. Response `202`: `{ submission: Submission }` — `status` reset to `'pending_analysis'`. Errors: `401`, `403`, `404`, `409` (already analyzed and not flagged for review).

### Analysis
- **`GET /analysis/:submissionId`** — Auth: same rule as parent submission. Response `200`: `{ status: SubmissionStatus; result: AnalysisResult | null }` — clients poll this (or use the Firestore real-time listener directly) while `status` is `'pending_analysis'`. Errors: `401`, `403`, `404`.

### Hotspots
- **`GET /hotspots`** — Auth: any authenticated user. Query: `?corridorId=` (required) `&bbox=minLat,minLng,maxLat,maxLng&sinceHour=ISODateString`. Response `200`: `{ cells: HotspotCell[] }`. Errors: `400`, `401`.
- **`GET /hotspots/:h3Index/history`** — Auth: any authenticated user. Query: `?range=24h|7d|30d` (default `7d`). Response `200`: `{ h3Index: H3Index; points: HotspotCell[] }`. Errors: `401`, `404`.

### Forecasts
- **`GET /forecasts/:corridorId/latest`** — Auth: any authenticated user. Response `200`: `ForecastRun`. Errors: `401`, `404`.
- **`GET /forecasts/:corridorId/history`** — Auth: any authenticated user. Query: `?range=7d|30d|90d`. Response `200`: `{ corridorId: CorridorId; runs: ForecastRun[] }`. Errors: `401`, `404`.

### Alerts
- **`GET /alerts`** — Auth: district_admin+ (jurisdiction-filtered server-side, never client-filtered). Query: `?status=&severity=&type=&pageSize=&pageToken=`. Response `200`: `Paginated<Alert>`. Errors: `401`, `403`.
- **`GET /alerts/:id`** — Auth: district_admin+, within jurisdiction. Response `200`: `Alert`. Errors: `401`, `403`, `404`.
- **`PATCH /alerts/:id/status`** — Auth: district_admin+, within jurisdiction. Request: `{ status: AlertStatus; note?: string }`. Response `200`: `Alert` — server **appends** to `statusHistory`, never overwrites. Errors: `400`, `401`, `403`, `404`, `409` (invalid transition, e.g. `resolved` → `new`).
- **`POST /alerts/:id/assign`** — Auth: district_admin+, within jurisdiction. Request: `{ officerId: string }`. Response `200`: `Alert`. Errors: `400` (officer missing or not covering the alert), `401`, `403`, `404`.

### Resource Coordination
- **`POST /resources/requests`** — Auth: district_admin+. Request: `{ resourceType, quantityNeeded, relatedAlertId? }` *(jurisdiction comes from the caller's own `User.jurisdiction`, never client-supplied)*. Response `201`: `ResourceRequest`. Errors: `400`, `401`, `403`.
- **`GET /resources/requests`** — Auth: district_admin+ (own jurisdiction), state_admin+ (own state, all districts). Query: `?status=&pageSize=&pageToken=`. Response `200`: `Paginated<ResourceRequest>`. Errors: `401`, `403`.

### Federation
- **`GET /federation/models`** — Auth: state_admin+. Query: `?type=hotspot|forecast`. Response `200`: `{ available: FederatedModel[]; currentlyActive: FederatedModel | null }`. Errors: `401`, `403`.
- **`POST /federation/models/:modelId/import`** — Auth: **super_admin only** *(deliberately the highest bar in the system — importing an external model into a production endpoint is the single highest-blast-radius action)*. Response `200`: `{ imported: FederatedModel; activatedAt: ISODateString }`. Errors: `401`, `403`, `404`, `409` (incompatible model schema version).
- **`GET /federation/exchange/hotspot-summary`** — Auth: state_admin+. Query: `?bbox=minLat,minLng,maxLat,maxLng`. Response `200`: `{ summary: Array<{ sourceStateCode, h3IndexGeneralized, weekStartDate, avgHotspotConfidence }> }`. Errors: `401`, `403`.

### Corridors (reference/config)
- **`GET /corridors`** — Auth: any authenticated user. Response `200`: `{ corridors: Corridor[] }`. Errors: `401`.
- **`GET /corridors/:id`** — Auth: any authenticated user. Response `200`: `Corridor`. Errors: `401`, `404`.

## 4.3 — Internal Event Contracts (Pub/Sub, not public REST)

| Topic | Publisher | Subscriber(s) | Payload |
|---|---|---|---|
| `submission.created` | `submission-service` | `analysis-service` | `{ submissionId: string }` |
| `analysis.completed` | `analysis-service` | `hotspot-service` | `{ submissionId: string; h3Index: H3Index; corridorId: CorridorId }` |
| `hotspot.updated` | `hotspot-service` | `alert-service` | `{ hotspotCellId: string; corridorId: CorridorId; hotspotConfidenceScore: number }` |
| `forecast.updated` | `forecast-service` | `alert-service` | `{ forecastRunId: string; corridorId: CorridorId; maxHorizonAQI: number }` |
| `alert.created` | `alert-service` | (notification dispatch, in-process) | `Alert['id']` |

**Design rule — don't violate it when adding a new event:** every payload is a thin reference, an ID plus the minimum needed to route/filter, never the full entity. The subscriber always re-reads current state from Firestore/BigQuery rather than trusting a potentially-stale event payload. This is deliberate: a slow subscriber never acts on stale data just because it processed an old event late.
