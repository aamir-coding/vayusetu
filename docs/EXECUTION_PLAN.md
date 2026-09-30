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

**Status (29 Sep 2026): complete and merged to `main` (PR #13, 28 Sep).** One follow-up commit (`9facf6e`, the Pub/Sub 401 fix, already live) and this closing audit are on `phase3/docs-ops` for the next PR.

Delivered:
- `docs/api/openapi.yaml` (25 endpoints, drift-tested against `shared-types`).
- IAM audit (`docs/security/IAM_AUDIT.md`) and least-privilege IAM, applied to NCR and MH.
- `monitoring.tf`: alerts, dashboard, opt-in budget. 17 policies live per state.
- `docs/RUNBOOK.md`, with incident logs for 27, 28 and 29 Sep and the Earth Engine licence line.
- Model cards for both models (`docs/models/`). The v1 hotspot metric bug is stated plainly, and v1 is relabelled failed in the Registry.
- Red-team set: 27 cases, 27/27 passing.
- Load-test tool (`packages/loadtest`). Chirag runs it with his own token.
- Mumbai-Pune fully deployed, backfilled and federated. All schedules are on in both states.
- National landing page **https://vayusetu.web.app**.

Rehearsed live, end to end (citizen photo → Gemini → fast path → Gemini-briefed alert to the right district):
- **NCR:** Karol Bagh → DL-CENTRAL (28 Sep).
- **Mumbai-Pune:** Pune Station → MH-PUNE (29 Sep). Two citizens fused to 0.607, and the alert was dispatched to 2 officials.

### Closing audit (29 Sep): the 26 Sep findings, re-checked against the code
| Finding | Status |
|---|---|
| S1 nothing consumed `submission.created` | Fixed: analysis-service, live in both states |
| S2 mock photo upload | Fixed: signed `upload-url` flow |
| S3 MSW hijacked dev | Fixed: mocks only with `VITE_USE_MOCKS`, plus a Vite API proxy |
| S4 corridor ID drift | Fixed: contract IDs, and the seed job deletes the legacy docs |
| S5 H3 res 7 vs 8 | Fixed: `OPERATIONAL_H3_RES = 8`, with a resolution test |
| S6 IMD fake weather | Fixed: the IMD job was replaced by the Weather API and ERA5 jobs |
| V1 CPCB "AQI" | Fixed: breakpoint sub-indices (`aqi.py`) |
| V2 Earth Engine demo job | Fixed: scheduled, non-interactive auth, MERGE |
| V3 non-idempotent ingestion | Fixed: staging table + MERGE on the natural key |
| **V4 no CI** | **Open.** Every deploy is a manual `gcloud builds submit`. Needs the Cloud Build GitHub App installed on the repo (owner: Aamir), then `enable_ci_triggers = true`. |
| V5 `pnpm test` OOM | Fixed: default `pnpm test` passes, 20/20 tasks |
| V6 offline queue jam | Fixed: permanently rejected reports are dropped |
| **V7 local Terraform state** | **Ready to run.** Backends enabled in code, and `infra/terraform/scripts/migrate-state.ps1` migrates the state (a person runs it; see the Terraform README). |
| V8 security posture | Fixed: Firestore rules with tests, analysis-service private. The geocoder fallback now refuses to start in production without a Maps key (submission and alert). |
| P1 hygiene | Fixed: `retry-analysis` uses `update`, `terraform fmt` is clean, pytest is dev-only, turbo outputs are set, admin i18n is done |
| Contract items | Fixed: upload-url documented, `featureSchemaVersion` on shared models, field-worker role. Open (minor): an alert doesn't record whether Gemini or the template wrote its briefing (it's only in logs). |

Health on 29 Sep:
- **All green:**
  - TypeScript: 323 tests across 13 packages (452 in total with Python, Terraform, E2E, portal and load-test suites; recounted 30 Sep)
  - ingestion: 46
  - ML: 15
  - Terraform: 42
  - E2E: 12
  - portal: 6
  - load-test library: 5
- **Type-check and lint are clean.**
- **Live:** 12/12 Cloud Run services ready and 5/5 sites up.

### Feature check against the spec (29 Sep, live)
Proven live today:
- **Voice note, in Hindi:** the note is transcribed word for word and the advisory comes back in Hindi with audio.
- **Advisories in Marathi and Punjabi.**
- **Forecast alerts:** a forced GRAP crossing produced 4 state alerts with grounded Gemini briefings.
- **Pipeline D escalation.**

Three bugs found and fixed while doing so (`0fd51b7`, `e41cf4f`), each with a regression test:
1. **Voice transcripts silently failed.** Speech-to-Text's service agent couldn't read the citizen-media bucket; the audio is now sent inline.
2. **New citizens were registered in the browser's language**, not the one chosen on screen.
3. **A language chosen before the profile loaded** never reached `User.preferredLanguage`.

**30 Sep: closed.**
- **Model sharing (Feature 4):**
  - Root cause: a cross-project `copyModel` needs the destination's Vertex AI agent to hold `roles/aiplatform.serviceAgent` on the source; we had granted `aiplatform.viewer`.
  - Chirag applied the fix (`fa38e47`).
  - The next manual syncs published `dl-hotspot-v2` and `dl-forecast-v1` into the Exchange registry and catalog, and Mumbai-Pune mirrored both.
- **Field-worker sensor reading:**
  - A real field-worker report (PM2.5 182, PM10 260) showed the reading was stored but never reached Gemini.
  - It now does (`b25eb57`). Re-analysed live, Gemini's note cites the "on-site spot sensor".
- **Super admin stuck on the login page:** the dashboard required a state claim for every role. Fixed (`c009bc6`).
- **Resource Coordination Board:** a live request was posted (DL, water sprinkler × 2).
- **Test alerts:** all dismissed by the officials, with an audit trail.
- **Also done:**
  - Remote Terraform state in GCS (all 3 environments).
  - NCR/MH drift applied.
  - Alert emails live (17 policies per state notify Chirag).
  - Load tests passed in both states.

**Every Product Spec feature has now been exercised live**, in both states where it applies.

Still open (none blocks the demo):
- **Optional:**
  - [ ] Install the Cloud Build GitHub App so PRs are tested automatically (audit V4). Until then deploys are manual `gcloud builds submit`.
  - [ ] A `super_admin` account in the Mumbai-Pune project, if the demo should show the one-click model import there. Import is super_admin-only, and only NCR has one.
  - [ ] A live Pipeline D question: the escalation is proven, but a question actually reaching a citizen needs a genuinely ambiguous photo (question → answer → re-analysis is E2E-tested in mock mode).
- **Tuning (not a bug):** hotspot model v2 raises 15–24 "watch" alerts in HR-GURUGRAM per 6-hourly run. Consider requiring citizen evidence for model-only watch alerts, or raising the model's alert threshold.

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
