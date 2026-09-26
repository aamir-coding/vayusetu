# VayuSetu — Team Roles & Repo Map
> Source: PRD §5–6 · Steward: whole team — each engineer owns and updates only their own row

## Repository Skeleton
Monorepo: pnpm workspaces + Turborepo. Every top-level folder maps to exactly one primary owner below, though everyone reads (and occasionally PRs into) `packages/shared-types`.

```
vayusetu/
├── apps/
│   ├── citizen-pwa/                      # OWNER: Engineer 1
│   │   src/screens/CaptureScreen.tsx     # camera + voice capture, offline queueing
│   │   src/screens/SnapshotResult.tsx    # renders AnalysisResult + TTS playback
│   │   src/screens/MyReportsScreen.tsx   # Persona 2 (field worker) history view
│   │   src/components/LanguageSwitcher.tsx, OfflineQueueBanner.tsx
│   │   src/lib/offlineQueue.ts           # Workbox/IndexedDB submission queue
│   │   src/lib/uploadClient.ts           # signed-URL direct-to-GCS upload
│   │   src/i18n/                         # cached Translation API bundles
│   │
│   ├── admin-dashboard/                  # OWNER: Engineer 1
│   │   src/screens/AlertQueue.tsx        # Officer Deshmukh's primary screen
│   │   src/screens/HotspotMap.tsx        # live heatmap, Google Maps Platform
│   │   src/screens/ForecastView.tsx      # Ms. Iyer's corridor forecast chart
│   │   src/screens/FederationPanel.tsx   # state_admin+, model import UI
│   │   src/screens/LiteModeTable.tsx     # low-bandwidth fallback view
│   │
│   ├── submission-service/               # OWNER: Engineer 2
│   │   src/routes/submissions.ts, users.ts
│   │   src/lib/reverseGeocode.ts         # Google Maps Geocoding -> Jurisdiction
│   │   src/lib/publishEvent.ts           # Pub/Sub publisher wrapper
│   │
│   ├── analysis-service/                 # OWNER: Engineer 3
│   │   src/subscribers/onSubmissionCreated.ts
│   │   src/gemini/triagePrompt.ts        # Pipeline A
│   │   src/gemini/clarifyPrompt.ts       # Pipeline D
│   │   src/lib/crossValidate.ts
│   │
│   ├── hotspot-service/                  # OWNER: Engineer 3
│   │   src/jobs/scoreHourlyGrid.ts       # Cloud Run Job entrypoint
│   │   src/lib/featureFusion.ts          # BigQuery join logic
│   │   src/lib/vertexPredict.ts          # Hotspot Confidence Model client
│   │   src/routes/hotspots.ts
│   │
│   ├── forecast-service/                 # OWNER: Engineer 3
│   │   src/jobs/scoreForecast.ts, src/lib/vertexForecast.ts, src/routes/forecasts.ts
│   │
│   ├── alert-service/                    # OWNER: Engineer 2
│   │   src/subscribers/onHotspotUpdated.ts, onForecastUpdated.ts
│   │   src/gemini/briefingPrompt.ts      # Pipeline C
│   │   src/lib/notificationGateway.ts    # FCM + SMS/WhatsApp abstraction
│   │   src/routes/alerts.ts
│   │
│   ├── federation-service/               # OWNER: Engineer 2
│   │   src/jobs/nightlySync.ts, src/lib/kAnonymize.ts, src/routes/federation.ts
│   │
│   └── ingestion-jobs/                   # OWNER: Engineer 4
│       src/earthEngineIngest.py          # Sentinel-5P, VIIRS/MODIS, Sentinel-2
│       src/imdIngest.py, cpcbIngest.py
│       src/citizenReportsRollup.ts       # Firestore -> BigQuery hourly aggregate
│
├── packages/
│   ├── shared-types/     # OWNER: Engineer 2 (all engineers contribute via PR) — API_CONTRACTS.md §4.1, verbatim
│   ├── ui-components/    # OWNER: Engineer 1 — shadcn/ui-based component library
│   ├── gemini-client/    # OWNER: Engineer 3 — typed Vertex AI Gemini wrapper, retry/backoff
│   ├── gcp-clients/      # OWNER: Engineer 2 — typed Firestore/BigQuery/Pub-Sub clients
│   ├── h3-utils/         # OWNER: Engineer 4 — h3-js wrapper: latLngToCell, kRing, resolution config
│   └── config/           # shared eslint, tsconfig, prettier
│
├── ml/                    # OWNER: Engineer 3 — hotspot-model/, forecast-model/ (KFP pipeline.py + feature_query.sql), notebooks/
├── infra/                 # OWNER: Engineer 2 — terraform/modules/state-deployment/, environments/{ncr,mumbai-pune}/, cloudbuild/ (one .yaml per app, path-triggered)
├── data/                  # OWNER: Engineer 4 — schemas/ (DB_SCHEMA.md DDL, versioned .sql), seed/ (corridor GeoJSON, station registry)
└── docs/                  # PRD_AND_ARCHITECTURE.md (master) + api/openapi.yaml (OWNER: Engineer 2, generated from API_CONTRACTS.md §4.2) + context/ (this knowledge base, see TEAM_SYNC_PROTOCOL.md)
```

## Engineer 1 — Frontend Lead & UX/Accessibility
**Scope:** `apps/citizen-pwa`, `apps/admin-dashboard`, `packages/ui-components`.

| Week | Deliverables |
|---|---|
| 1 — Foundations | Tailwind + shadcn/ui design system locked; every core screen wireframed; API client stubbed against `API_CONTRACTS.md` using Mock Service Worker (frontend never blocked on backend readiness); Firebase Auth phone-OTP end-to-end. |
| 2 — Core Pipelines | `CaptureScreen` (camera + voice, GPS/manual-pin fallback, client compression, offline queue); `SnapshotResult` with TTS; wired to real `submission-service`/`analysis-service` as they land; `AlertQueue` skeleton on mock data. |
| 3 — Integration & Multilingual | i18next + language switcher across both apps; `HotspotMap` wired to real `hotspot-service`; `AlertQueue` wired to real-time Firestore listeners; Lite Mode fallback table; accessibility pass (contrast, tap targets, screen-reader labels). |
| 4 — Deployment & Pitch | `FederationPanel` (state_admin+ import UI); Lighthouse PWA + bundle-size budget; low-end Android QA; production deploy to Firebase Hosting; UI segments for pitch video. |

**Definition of done (Day 30):** a citizen on a mid-range Android phone on throttled 3G completes a full report-to-advisory loop in their own language in under 20 seconds of active interaction; an official triages, acts on, and resolves an alert without leaving the dashboard.

## Engineer 2 — Backend & Cloud Infrastructure / GCP Lead
**Scope:** `apps/submission-service`, `apps/alert-service`, `apps/federation-service`, `infra/terraform`, `infra/cloudbuild`, `packages/gcp-clients`, steward of `packages/shared-types`, `docs/api/openapi.yaml`.

| Week | Deliverables |
|---|---|
| 1 — Foundations | `packages/shared-types` is the **first PR merged on the project**, before any other app code. Terraform module for a full state deployment (Cloud Run, Firestore, BigQuery, Pub/Sub, least-privilege service accounts, Secret Manager) applied to dev NCR. `submission-service` scaffolded. Pub/Sub topics stood up. |
| 2 — Core Pipelines | `submission-service` fully implements its contract, incl. Geocoding-based jurisdiction resolution. `alert-service` skeleton subscribing to (mocked) `hotspot.updated`/`forecast.updated`; notification gateway channel-abstracted, FCM live, SMS/WhatsApp stubbed behind the same interface. Cloud Build CI/CD path-triggered per app. |
| 3 — Integration & Multilingual | `alert-service` fully wired to the real Gemini briefing pipeline + real hotspot/forecast events. `federation-service` built: nightly Cloud Run Job, k-anonymization, Model Registry publish/pull. Second environment (Mumbai-Pune) provisioned from the *same* Terraform module. |
| 4 — Deployment & Pitch | Firestore security-rules audit + IAM least-privilege audit. Load testing `submission-service`/`alert-service` at pilot volume. Deployment runbook incl. Earth Engine licensing budget line. Cloud Monitoring dashboards/alerting live. `openapi.yaml` finalized. |

**Definition of done (Day 30):** two independently provisioned, data-sovereign environments (NCR, Mumbai-Pune) live, load-tested, monitored, exchanging federated model artifacts — interoperability is a running system, not a diagram.

## Engineer 3 — AI Pipeline & Gemini/Vertex AI Integration Lead

> **Status (26 Sep 2026): role vacant.** Engineer 3 left the team with no committed work. This scope is being delivered under the other roles per `docs/EXECUTION_PLAN.md`, with no features cut.

**Scope:** `apps/analysis-service`, `apps/hotspot-service`, `apps/forecast-service`, `packages/gemini-client`, `ml/`.

| Week | Deliverables |
|---|---|
| 1 — Foundations | `packages/gemini-client`: typed Vertex AI wrapper, retry/backoff, function-calling helper validating against `AI_PIPELINES.md` schemas via Zod. Pipeline A's system instruction hand-tuned against ~50 labeled real photos before wiring into any service. Draft BigQuery feature-extraction SQL for `hotspot_training_dataset`. |
| 2 — Core Pipelines | `analysis-service` fully live end-to-end (Pub/Sub → Gemini 3.7 Flash → validated → Firestore write). First Vertex AI AutoML Tabular training run on real-plus-synthetic data — deliberately a rough first model, iterating is Week 3's job. `hotspot-service` scaffolded, calling the rough model. |
| 3 — Integration & Multilingual | `forecast-service` built; first AutoML Forecasting run per corridor. Pipeline C implemented, wired into `alert-service`. Hotspot model retrained on the fuller dataset. Vertex AI Pipelines (KFP) retrain DAG built for both models. |
| 4 — Deployment & Pitch | Model evaluation write-up: precision/recall for hidden-hotspot flags vs. held-out ground truth; MAPE per forecast horizon. Adversarial/red-team pass on Pipeline A (unrelated photos, misleading context, indoor photos) confirming `indeterminate`/`needsHumanReview` paths hold. Pipeline D as time allows. Final models evaluated, documented (model cards), registered. |

**Definition of done (Day 30):** both models trained, evaluated against held-out ground truth with written accuracy numbers, reproducibly retrainable via a pipeline, red-teamed against the obvious ways a citizen-photo pipeline gets fed garbage.

## Engineer 4 — Data Engineering, External APIs & QA/Testing Lead
**Scope:** `apps/ingestion-jobs`, `packages/h3-utils`, `data/`, cross-cutting QA/testing — contract tests against `API_CONTRACTS.md` and E2E tests are explicitly this role, since no other role naturally owns "does the whole system work together."

| Week | Deliverables |
|---|---|
| 1 — Foundations | Earth Engine noncommercial project registered; `earthEngineIngest.py` pulling Sentinel-5P NO₂/aerosol, VIIRS/MODIS fire, Sentinel-2 burn-scar for NCR into `satellite_features`. data.gov.in access registered; `cpcbIngest.py` into `ground_truth_aqi`. `packages/h3-utils` built + unit-tested. NCR + Mumbai-Pune boundary GeoJSON seeded into `corridors`. |
| 2 — Core Pipelines | `imdIngest.py` into `meteorology_features`. `citizenReportsRollup.ts` hourly aggregation. Monitoring-station registry seeded from CPCB/data.gov.in. Contract-test suite written against every `API_CONTRACTS.md` endpoint — written *before* each endpoint is finished, to catch integration drift immediately. |
| 3 — Integration & Multilingual | Data-quality monitoring dashboards (is every ingestion job on schedule, is any feed stale/gapped). Mumbai-Pune satellite/met/ground-truth fully backfilled. Full E2E suite (Playwright) covering citizen-report-to-alert end to end. |
| 4 — Deployment & Pitch | Full regression pass across all 23 REST endpoints and every E2E flow. Synthetic, rehearsed demo-day scenario (a reliable "hidden hotspot" event not dependent on real pollution occurring on judging day). Final data-quality/ingestion runbook. |

**Definition of done (Day 30):** every external data source flowing on schedule with visible health monitoring; the full request-to-alert path covered by automated tests that ran in CI on every PR; the pitch demo doesn't depend on the weather cooperating.

## 4-Week Milestone Roadmap (cross-team "done")

| Week | Theme | Cross-Team "Done" Definition |
|---|---|---|
| 1 | Foundations & Contracts | `shared-types` v1.0 locked/merged; dev GCP environment live via Terraform; every service skeleton deployed to Cloud Run (even returning mock data); Gemini client validated against real function-calling round-trips; both external ingestion jobs landing real data on schedule. |
| 2 | Core Pipelines | Citizen photo → Gemini 3.7 Flash → Firestore path fully live end-to-end; a first (rough) Hotspot Confidence Model trained and registered; contract-test suite running in CI against real (not mocked) endpoints. |
| 3 | Integration & Multilingual UI | Full alert pipeline live: hotspot/forecast event → Gemini 3.1 Pro briefing → jurisdiction-routed, multi-channel alert. Citizen and admin UIs fully multilingual. Federation Exchange functionally exchanging models between two real environments. Mumbai-Pune fully backfilled. |
| 4 | Deployment, Benchmarking & Pitch | Both environments load-tested, security-reviewed, monitored in production. Both models evaluated with written accuracy numbers. Full E2E regression suite green. Demo-day scenario rehearsed, weather-independent. Pitch video recorded. |
