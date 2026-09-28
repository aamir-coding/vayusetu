# VayuSetu — Execution Plan (post-realignment)

> Status of record from 26 Sep 2026. Engineer 3 has left. Claude is implementing all remaining engineering, and Chirag handles accounts, keys, billing and console-only steps. Scope is unchanged: every feature in `docs/context/01_PRODUCT_SPEC.md`, built on Google services only.

## Technology decisions (binding)

| Need | Decision | Why |
|---|---|---|
| Citizen triage (Pipeline A), clarification (D) | Gemini Flash on Vertex AI via `@google/genai` (`packages/gemini-client`) | As planned. Model ids come from env vars, because Model Garden availability in `asia-south1` must be confirmed. |
| Official briefings (Pipeline C) | Gemini Pro on Vertex AI | As planned; alert-service already has the guard layer. |
| Voice in / out (Pipeline B) | Cloud Speech-to-Text v2 (Chirp) and Cloud Text-to-Speech, with audio cached in GCS | As planned. |
| Static UI strings | Cloud Translation API, build-time bundle generation | As planned. |
| Hotspot Confidence Model | Vertex AI **AutoML Tabular**, batch prediction BigQuery → BigQuery each hour | As planned. Batch prediction avoids paying for an always-on endpoint. |
| 72-h forecast | Vertex AI **AutoML Forecasting** (station-level series, aggregated per corridor), batch prediction every 6 h | As planned. |
| Retraining | **Vertex AI Pipelines** (KFP + Google Cloud Pipeline Components): BQ extract → AutoML train → evaluate → conditional Model Registry upload with federation labels | As planned. |
| Ground truth | CPCB via data.gov.in (measured), plus the **Google Air Quality API** (modeled, 30-day hourly history) | CPCB alone has no history API. The Air Quality API backfills training labels and covers cells with no monitor. |
| Meteorology | **Google Weather API** (observed + 72 h forecast). ERA5 through Earth Engine for historical backfill. | IMD has no open real-time API. |
| Satellite | Earth Engine: S5P NO₂/AAI, MODIS MAIAC AOD, FIRMS, Sentinel-2 dNBR, exported straight to BigQuery | As planned. |
| Batch/scheduled work | Cloud Run Jobs + Cloud Scheduler | One ingestion image. Jobs over Functions because EE exports run up to an hour. |
| CI/CD | Cloud Build: `ci.yaml` (all suites on every PR) plus per-app deploy yamls | Google-native, already the plan. |
| Frontend hosting | Firebase Hosting, same-origin `/api/v1/**` rewrites to Cloud Run (generated from `packages/config/api-routes.json`) | No CORS; dev proxy uses the same map. |
| Maps | Maps JavaScript API (heatmap, pin-drop), Geocoding API (jurisdiction) | As planned. |

Endpoint ownership (fixes the "unowned endpoints" gap): `submission-service` serves users, submissions, **analysis, corridors, resources**. `analysis-service` is a private Pub/Sub worker with no public routes. Hotspots → `hotspot-service`, forecasts → `forecast-service`, federation → `federation-service`, alerts → `alert-service`.

## Phases

### Phase 0 — Clean baseline (this branch: `phase0/baseline`)
- [x] `pnpm test` no longer OOMs (turbo concurrency 2, vitest `maxForks: 2`)
- [x] Terraform: deduplicated `apis.tf`, `fmt` clean, drops `imd-api-key`, adds Air Quality / Weather / Earth Engine APIs
- [x] Ingestion rewritten as one package (`apps/ingestion-jobs/vayusetu_ingest`):
  - H3 resolution 8 everywhere
  - IST → UTC timestamps
  - CPCB station AQI computed as the max sub-index (≥ 3 pollutants incl. PM)
  - Idempotent staging + MERGE writes; no more fabricated IMD data
  - Earth Engine auth runs without an interactive login
  - New tables: `h3_cells`, `monitoring_stations`, `modeled_aqi`, `meteorology_forecast`
  - Migrations for burn scar and contributor count
  - 33 tests
- [x] Canonical corridor seed (`data/seed/`): `ncr-airshed`, `mumbai-pune-corridor`, state codes, contract GRAP shape. The `seed` job deletes the legacy `ncr_airshed` docs and rows.
- [x] Terraform `ingestion.tf`: 8 Cloud Run Jobs, Scheduler (opt-in), least-privilege SA, reference bucket, CI trigger, and plan tests (7/7)
- [x] Cloud Build `ci.yaml` (Node, Python and Terraform on every PR) and `ingestion-jobs.yaml`
- [x] Frontend:
  - Real signed-URL upload flow
  - MSW opt-out (`VITE_USE_MOCKS=false`) and a Vite proxy from the shared route map
  - Network-aware photo compression and the real audio MIME type
  - Offline queue keeps only retryable failures and removes permanently rejected reports
  - Fixed the dashboard env port
- [x] `infra/scripts/gen-firebase-json.mjs` (Hosting rewrites per environment)

### Phase 1 — Build the missing AI/ML layer
1. `packages/gemini-client`: commit and harden Engineer 3's kit (retries, Zod function-calling, model ids from env), with unit tests on a fake transport.
2. `analysis-service` (Pipeline A + B + D):
   - `submission.created` push → Speech-to-Text (voice) → context (nearest station, satellite AOD) → Gemini Flash forced function call → Zod → cross-validation → TTS advisory (GCS cache keyed by hash) → `analysisResults` → submission status → `analysis.completed`.
   - Pipeline D: one clarifying question stored on the result, answered through a new `POST /submissions/:id/clarify` (contract addition).
3. alert-service `modelCall.ts` (Pipeline C) → `BRIEFING_GENERATOR=gemini`.
4. `submission-service`: `GET /analysis/:id`, `GET /corridors[/:id]`, `POST|GET /resources/requests`. Contract additions: field-worker `fieldSensorReading`, and a role upgrade to `field_worker` via `POST /users/me/role`.
5. `ml/`:
   - Feature SQL for `hotspot_training_dataset` and `forecast_training_dataset`.
   - Label definitions: hidden hotspot = modeled AQI at the cell exceeds the nearest monitor by ≥ 1 NAQI category AND no monitor within 3 km.
   - KFP pipelines for both models.
   - Demo-scenario synthetic generator, clearly flagged as synthetic.
6. `hotspot-service`:
   - Hourly job: fused features → AutoML batch prediction → `HotspotCell` (BigQuery full grid, top cells to Firestore) → `hotspot.updated`.
   - Also triggered by `analysis.completed` for fast re-scores of the reported cell.
   - Serves `GET /hotspots` and `/hotspots/:h3/history`.
   - Uses a heuristic scorer until the first model is registered (`modelVersion: heuristic-v0`).
7. `forecast-service`: every 6 h, AutoML batch forecast → `ForecastRun` → `forecast.updated`. Serves `GET /forecasts/:c/latest|history`.

### Phase 2 — Integrate, secure, deploy

**Status (27 Sep 2026, branch `phase1/ai-layer`):**
- Done in code, tested:
  - Firestore rules + emulator tests (release gated by `deploy_firestore_rules`).
  - Admin: H3 hexagons on Google Maps (Data layer, not the deprecated HeatmapLayer), cell detail with 7-day history; real-time AlertQueue (rules-scoped `onSnapshot`); ForecastView trend; FederationPanel active model, super_admin-only import, Cross-state View; web push (FCM + VAPID); en/hi/pa/mr.
  - PWA: Pipeline D clarify card, Cloud TTS playback, sensor panel (monitor, AOD, field-worker PM), "Answer needed" in My Reports.
  - `translate-locales` (Cloud Translation v3, human edits win).
  - Terraform:
    - Firebase web apps + admin Hosting site; Maps browser key (Terraform, restricted).
    - `frontend-env-<app>` secrets → Hosting deploys from Cloud Build.
    - federation-service env + nightly `federation-sync` job.
    - `modules/exchange` + `environments/exchange`; `environments/mh` (Mumbai-Pune).
  - federation-service reads the full BigQuery grid and runs cleanly before the Exchange exists.
- Waiting on apply/deploy approval: the NCR plan (20 add / 2 change / 0 destroy), the federation-service image, the first Hosting deploys.
- Waiting on Chirag: VAPID key, Auth providers, the two new projects (see below).
- Still to build:
  - Playwright E2E and contract tests.
  - Private ingress for Pub/Sub/Scheduler-only services.
  - Data-freshness monitoring.

- Firestore security rules (jurisdiction-scoped, with emulator tests); tighten Cloud Run ingress (Pub/Sub/Scheduler-only services private).
- Frontends:
  - HotspotMap on the Maps JS heatmap with real endpoints; ForecastView and FederationPanel with real data.
  - AlertQueue real-time listeners; dashboard FCM token.
  - Admin i18n; Translation-API bundle script.
  - Field-worker sensor reading and trend view.
- Mumbai-Pune environment and National Exchange project (Terraform); federation-service deployed; the nightly job exchanges real models.
- Playwright E2E (report → analysis → hotspot → alert) and contract tests in CI; data-freshness monitoring.

### Phase 3 — Week-4 deliverables
Load tests, Monitoring dashboards and alerting, IAM audit, `openapi.yaml`, runbook (including the Earth Engine commercial-licence budget line), model evaluation write-up and model cards, Pipeline A red-team set, rehearsed demo scenario.

**Status (28 Sep 2026, branch `phase3/docs-ops`, not yet pushed):**
- Done:
  - `docs/api/openapi.yaml`: 25 endpoints, with a drift test against `shared-types`.
  - IAM audit (`docs/security/IAM_AUDIT.md`, 9 findings) and least-privilege IAM in Terraform (`iam.tf`, `iam_scoped.tf`, 6 guard tests).
  - `monitoring.tf`:
    - alerts: 5xx, 429 bursts, failed jobs, data freshness, dead letters, uptime
    - dashboard
    - opt-in budget
  - `docs/RUNBOOK.md`, including incident logs for 27 and 28 Sep and the Earth Engine licence line.
  - Model cards for both models in `docs/models/`. The v1 hotspot metric bug is stated plainly.
  - Red-team set: 27 cases in 8 categories, 27/27 passing after prompt rules 8–10.
  - Load-test tool in `packages/loadtest`. It hits read-only endpoints; Chirag runs it with his own token.
  - Hotspot heatmap: model scores are calibrated, with a top-25 floor.
  - Mumbai-Pune: all services and both web apps deployed; migrate, seed, land-cover and every backfill completed.
- Demo rehearsal (`docs/DEMO.md` §5):
  - The citizen → Gemini → hotspot fast path → alert path now works live.
  - Seven bugs that blocked it were found and fixed. Each would have broken the live demo:
    - bucket CORS
    - a cached `/users/me`, both the service worker and the Hosting CDN
    - register 409
    - polling stopped on `queued`
    - deep links before sign-in
    - flagged fires never counted
    - a missing Firestore index
  - The admin-side beats need Chirag's sign-in.
- Waiting on Chirag's approval:
  - `terraform apply` on NCR and MH: IAM scoping, monitoring, CORS convergence, MH staged flags, MH federation sync.
  - `terraform apply` on the Exchange, adding MH as a member.
  - Relabel hotspot v1 in the Model Registry.
  - Push `phase3/docs-ops` and open the PR.

## What Chirag needs to do (console / accounts)

Numbered in the order they unblock work. ✅ = done.

1. **Local GCP auth for Claude's session:** `gcloud auth application-default login` (as chiraggk53@gmail.com), then `gcloud auth application-default set-quota-project vayusetu-ncr-dev`.
2. **Budget:** set a billing budget alert on the billing account (suggested ₹15,000/month for dev). Expected spend:
   - AutoML training, about ₹2–4k per training run
   - Batch predictions, about ₹1–2k/month
   - Maps environment APIs, low (within free caps at the configured sampling)
   - Gemini, a few hundred ₹ at pilot volume
3. **Earth Engine:** register `vayusetu-ncr-dev` for noncommercial use at code.earthengine.google.com/register, if not already done (Anjan's sample worked, so likely yes). Confirm in the console.
4. **Maps Platform:** enable the *Air Quality API*, *Weather API* and *Maps JavaScript API*.
   - Server key (existing `google-maps-api-key` secret): add Air Quality + Weather to its API restrictions.
   - ~~Browser key~~ now Terraform-managed (`maps.tf`, restricted to Maps JS + our Hosting origins). Nothing to do.
5. **data.gov.in:** register and get an API key → `gcloud secrets versions add cpcb-api-key --data-file=-` (after the Terraform apply creates the secret).
6. **Vertex AI:** in Model Garden, confirm which Gemini Flash / Pro ids are enabled in `asia-south1` (Claude can check once #1 is done).
7. **Firebase console:**
   - Enable Phone and Email/Password sign-in.
   - ~~Add a Web app~~ now Terraform-managed (`firebase.tf`). Nothing to do.
   - Cloud Messaging → Web Push certificates → **Generate key pair**, then send Claude the **public** key. It goes in `terraform.tfvars` as `firebase_vapid_public_key`.
   - Add authorized domains for Hosting.
8. **Cloud Build ↔ GitHub:** install the Google Cloud Build GitHub App on `aamir-coding/vayusetu` and connect the repo (Cloud Build → Triggers → Connect repository, region global). Aamir owns the repo, so he may need to approve.
9. **Two new projects** (billing linked): `vayusetu-mh-dev` (Mumbai-Pune) and `vayusetu-exchange-dev` (National Exchange). Grant chiraggk53@gmail.com Owner on both.
10. **Approvals Claude will ask for before acting:**
    - `terraform apply` on each project
    - Migrating Terraform state to a GCS bucket
    - Pushing branches / opening PRs on GitHub
    - Reseeding live Firestore
