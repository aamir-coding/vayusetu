# VayuSetu — Operations Runbook

How to deploy, roll back and handle incidents in each state deployment. The section names match the alert policies in `infra/terraform/modules/state-deployment/monitoring.tf`, and every alert links here.

> **Standing rules**
> - Ask Chirag before any `terraform apply`, any `git push` or PR, anything that spends money on training, and deleting or overwriting data.
> - Never paste passwords or tokens into chat, logs or docs.
> - One session at a time per Terraform environment (state is local, see §2.3).

## 1. System map

| | NCR (`vayusetu-ncr-dev`) | Mumbai-Pune (`vayusetu-mh-dev`) | Exchange (`vayusetu-exchange-dev`) |
|---|---|---|---|
| Citizen PWA | https://vayusetu-ncr-dev.web.app | https://vayusetu-mh-dev.web.app | — |
| Admin console | https://vayusetu-ncr-dev-admin.web.app | https://vayusetu-mh-dev-admin.web.app | — |
| Federation identity | `DL` (owns DL, HR, UP, RJ) | `MH` | shared BigQuery + Model Registry |
| Terraform env | `infra/terraform/environments/ncr` | `…/mh` | `…/exchange` |

Region: `asia-south1` everywhere. Gemini runs on Vertex `global`, and Speech-to-Text on `us` (Chirp 3).

- **Services (Cloud Run, `<name>-<env>`):**
  - submission-service: users, submissions, analysis, corridors, resources
  - alert-service
  - hotspot-service
  - forecast-service
  - federation-service
  - analysis-service: private, Pub/Sub push only
- **Jobs (Cloud Run Jobs + Cloud Scheduler):**
  - Ingestion: `ingest-*` (the 12 jobs in `ingestion.tf`)
  - Scoring: `hotspot-score-hourly`, whose model runs on hours divisible by `hotspot_model_every_hours` with the heuristic in between, and `forecast-score` (6-hourly)
  - Federation: `federation-sync` (02:30 IST)
- **Event flow:**
  1. `submission.created` → analysis-service
  2. → `analysis.completed` → hotspot-service (fast path)
  3. → `hotspot.updated` / `forecast.updated` → alert-service
  4. → FCM / SMS / WhatsApp

  Every push subscription has a dead-letter topic.

## 2. Deploy

### 2.1 Services, jobs and web apps (Cloud Build)
Build from a clean checkout of the commit you mean to ship, at the repo root. Each pipeline runs install → type-check → lint → test first, and deploys only if all pass.

```bash
P=vayusetu-ncr-dev; ENV=ncr-dev     # or vayusetu-mh-dev / mh-dev
SA="projects/$P/serviceAccounts/cloudbuild-$ENV@$P.iam.gserviceaccount.com"
gcloud builds submit --project $P --region asia-south1 \
  --config infra/cloudbuild/<app>.yaml \
  --substitutions=_DEPLOY=true,_ENV=$ENV,_REGION=asia-south1 \
  --service-account="$SA" .
```

`<app>` is one of: `submission-service`, `analysis-service`, `alert-service`, `hotspot-service`, `forecast-service`, `federation-service`, `ingestion-jobs`, `citizen-pwa`, `admin-dashboard`.
- Services: the pipeline swaps the image only. Env, secrets and scaling are Terraform's (`cloud_run.tf`), and `gcloud run deploy --image` keeps them.
- `hotspot-`, `forecast-` and `federation-service` also update their job's image.
- `ingestion-jobs` updates all 12 `ingest-*` jobs, then runs `ingest-migrate --wait` (idempotent DDL).
- Web apps build with the `frontend-env-<app>` secret (Firebase config, Maps key, VAPID), which Terraform writes from the resources that own them. They then run `firebase deploy --only hosting:<citizen|admin>`.

Once the GitHub App is connected (`enable_ci_triggers = true`), the same pipelines run on every PR (validate only) and on merge to main (deploy).

### 2.2 Post-deploy smoke
Get a Firebase ID token from a signed-in test account yourself; never paste one into chat. Then:
```bash
T=<your ID token>; H=https://vayusetu-ncr-dev-admin.web.app/api/v1
curl -sf -H "Authorization: Bearer $T" "$H/corridors" | head -c 200
curl -sf -H "Authorization: Bearer $T" "$H/hotspots?corridorId=ncr-airshed" | head -c 200
curl -sf -H "Authorization: Bearer $T" "$H/forecasts/ncr-airshed/latest" | head -c 200
```
Also:
1. Submit one report in the PWA. It should show a result within seconds, including audio.
2. Check that the newest job executions succeeded:
   ```bash
   gcloud run jobs executions list --project $P --region asia-south1 --limit 10
   ```
   Hotspot and forecast summaries log a `modelVersion`: `projects/…/models/…@N` on model hours, `heuristic-v0` or `persistence-v0` otherwise.

### 2.3 Terraform
State is **local** to the checkout that last applied: `infra/terraform/environments/<env>/terraform.tfstate`, gitignored, together with `terraform.tfvars`. Move it to a GCS backend before a second person ever applies (this needs approval).

1. `terraform plan -out=plan.tfplan` and read every line. Replacements of Cloud Run services, Firestore, BigQuery tables or buckets are **never** expected.
2. Get Chirag's approval for that exact plan.
3. `terraform apply plan.tfplan`. Re-plan if anything changed in between.
4. Run the smoke tests (§2.2).

Staged flags (each has its prerequisite in a comment in `terraform.tfvars`):
- `maps_api_key_secret_populated`, `openaq_api_key_secret_populated`, `cpcb_api_key_secret_populated`
- `enable_*_push_subscription(s)`
- `enable_ingestion_schedules`, `enable_model_schedules`
- `enable_federation_sync`
- `deploy_firestore_rules`

### 2.4 New state environment (the Mumbai-Pune checklist)
1. Chirag creates the project with billing, grants Owner, registers it for Earth Engine (noncommercial), and adds the Firebase Auth providers.
2. Stage-1 apply: infrastructure only, every flag off.
3. Chirag adds the secret versions: Maps server key, OpenAQ, and data.gov.in if available.
4. Deploy all 9 pipelines (§2.1) with `_ENV=<env>`.
5. Run the data bring-up. Each is `gcloud run jobs execute <job>-<env> [--args=…]`:
   1. `ingest-seed`
   2. `ingest-openaq-backfill` (hours)
   3. `ingest-seed` again, which links the monitors to the grid
   4. `ingest-earth-engine --args=land-cover`
   5. `ingest-earth-engine --args=earth-engine,--start,<YYYY-MM-DD>,--days,<N>,--parallel,10`
   6. `ingest-era5 --args=era5,--start,…,--days,…`
   7. `ingest-air-quality --args=air-quality,--hours,720` (paid Maps API, about 700 calls; once only)
6. Flip the staged flags and apply (with approval):
   - the secrets-populated flags
   - push subscriptions
   - ingestion schedules
   - model schedules
   - `enable_federation_sync`
7. Add the new state's `federation_identity` to `environments/exchange` `member_states` and apply the Exchange (with approval).

## 3. Rollback

| What | How | Time |
|---|---|---|
| A service revision | `gcloud run services update-traffic <svc>-<env> --to-revisions=<previous-revision>=100 --region asia-south1`. List revisions with `gcloud run revisions list --service <svc>-<env>`. | seconds |
| A job image | `gcloud run jobs update <job>-<env> --image=<previous image digest> --region asia-south1`. Digests are in Artifact Registry `vayusetu/<app>`. | seconds |
| A web app | Firebase console → Hosting → release history → **Rollback**, or `firebase hosting:clone <site>:<old-version-id> <site>:live`. | seconds |
| A model version | Move the Registry alias. Scoring always reads `default`, so no redeploy is needed (snippet below). | next run |
| Model → baseline | Terraform `hotspot_scorer = "heuristic"` / `forecaster = "persistence"` (needs approval). A failing batch prediction already falls back automatically for that run. | next run |
| Terraform | Revert the commit, then plan and apply the previous config (needs approval). Never edit state by hand. | minutes |

Moving the `default` alias back to a previous model version:
```python
from google.cloud import aiplatform
aiplatform.init(project="vayusetu-ncr-dev", location="asia-south1")
m = aiplatform.Model("projects/…/models/<id>")
m.versioning_registry.add_version_aliases(["default"], version="<previous version id>")
```

**Relabel a model version.** Always address the version explicitly (`@<id>`). The SDK's `Model.update()` writes to whichever version holds `default` (see the hotspot model card). A label update **merges**: keys you leave out are kept. So send the full label set, and overwrite a stale key rather than dropping it.

Pending: the stale threshold on hotspot v1 becomes `none` (PowerShell):
```powershell
$M = "projects/818188514572/locations/asia-south1/models/4203279021359759360"
$T = gcloud auth print-access-token
$Body = '{"labels":{"vayusetu-model-type":"hotspot","vayusetu-gate":"failed","vayusetu-gate-value":"0_2923","vayusetu-gate-metric":"auprc","vayusetu-feature-schema":"hs-v1","vayusetu-state":"dl","vayusetu-train-start":"2025-09-27","vayusetu-train-end":"2026-09-27","vayusetu-train-rows":"540134","vayusetu-threshold":"none"}}'
Invoke-RestMethod -Method Patch -Uri "https://asia-south1-aiplatform.googleapis.com/v1/${M}@1?updateMask=labels" -Headers @{ Authorization = "Bearer $T" } -ContentType "application/json" -Body $Body
```

## 4. Incidents

Record every incident in §5, even small ones.

### 5xx spike
1. Logs: `resource.type="cloud_run_revision" resource.labels.service_name="<svc>-<env>" severity>=ERROR`.
2. `PERMISSION_DENIED …` right after an IAM change: grant the **named** permission on the **named** resource (see `docs/security/IAM_AUDIT.md`). Never restore a project-wide role.
3. It started with a deploy: roll back the revision (§3), then fix forward.
4. Vertex or Gemini errors (analysis, alert): Pipeline A retries once, then marks the report `failed`. Alerts fall back to the template briefing. Check Vertex quota in the console.

### 429 / billing
- **Platform 429:** latency ≈ 0 ms and a 14-byte body `Rate exceeded.`. Cloud Run is rejecting before the container, because billing is disabled, the service is re-activating after billing returns, or max instances were hit.
  - **Billing check:** `gcloud billing projects describe <project>` must show `billingEnabled: true`.
  - **Max instances:** raise `max_instances` in `cloud_run.tf` with approval.
- **App 429:** normal latency and an `ApiError` body with `RATE_LIMITED`. This is the per-user limiter, keyed on the Firebase uid (60/min for submission and federation, 120/min for the others).
- **After billing returns:** expect about 30 minutes of platform 429s, and verify the failed jobs re-ran (§ "Job failed").

### Job failed
1. `gcloud run jobs executions list --job <job>-<env> --region asia-south1 --limit 5`, then its logs.
2. Every job is idempotent (staging + MERGE, deterministic ids), so re-running is always safe: `gcloud run jobs execute <job>-<env> --region asia-south1`.
3. Common causes:
   - **An upstream API is down:** OpenAQ, data.gov.in, Maps. The job retries next cycle; the freshness alert fires only if it persists.
   - **Earth Engine:** "Project not registered" means registration lapsed; a quota error means lowering `--parallel`.
   - **Scoring:** "no cells" means seed didn't run in this environment.

### Stale data
The alert fires when a scheduled job has not succeeded within its window (3 h for hourly, 13 h for 6-hourly jobs).
1. Is the Cloud Scheduler job enabled and triggering? `gcloud scheduler jobs describe <job>-<env> --location asia-south1`.
2. Are executions failing? Go to "Job failed".
3. What users see meanwhile:
   - The heatmap keeps showing the last scored hour.
   - Forecasts show the last run, with its timestamp in the Forecast view.
   - Citizen analysis degrades to "modeled or no reference" cross-validation.

### Dead letters
Pub/Sub gave up after the maximum delivery attempts. Inspect without losing the message:
```bash
gcloud pubsub subscriptions pull analysis-service.dead-letter-inspect --limit 10 --project $P
```
(also `alert-service.dead-letter-inspect`). The payloads are thin references like `{ "submissionId": "…" }`.
1. Fix the cause (the service's logs at that time).
2. Replay:
   - **Reports:** `POST /api/v1/submissions/<id>/retry-analysis`, or re-publish:
     ```bash
     gcloud pubsub topics publish submission.created --message='{"submissionId":"<id>"}'
     ```
   - **Hotspot or forecast events:** the next scheduled run re-publishes them.
3. Then ack the inspected messages.

Precedent: the first live report dead-lettered after 8 attempts, because Vertex's service agent couldn't read `citizen-media`. It was fixed with a bucket-level grant and replayed.

### Service down
The uptime check on submission-service `/health` failed for more than 10 minutes.
1. Check billing first (see the 27 Sep incident).
2. `gcloud run services describe submission-service-<env>`: is the latest revision ready?
3. Roll back the revision if a deploy preceded it.

### Budget
Spend is tracked against `monthly_budget` (₹15,000 for dev).
- **Big movers:**
  - Vertex AutoML training: ₹2–4k per run, only with approval
  - Batch predictions: hourly model runs are expensive, hence `hotspot_model_every_hours = 6`
  - Air Quality API backfills
  - Gemini at volume
- **Levers:**
  - Raise `hotspot_model_every_hours`
  - Pause `enable_model_schedules`
  - Reduce `AQ_SAMPLE_CELLS_PER_CORRIDOR`
  - Scale-to-zero is already on for every service

## 5. Incident log

### 2026-09-27 — NCR: billing interruption, then platform 429s (~10:05–10:50 UTC)
- **Impact:**
  - About 45 minutes of degraded or no service in `vayusetu-ncr-dev`.
  - Scheduled jobs in flight were terminated:
    - `hotspot-score-hourly-ncr-dev-wxvlh` (09:40)
    - `forecast-score-ncr-dev-2n5zd` (09:45)
    - `ingest-weather-ncr-dev-4jpxt` (10:05)
    - `ingest-rollup-ncr-dev-blg5m` (10:20)
    - `hotspot-score-hourly-ncr-dev-p4nc2` (10:40)
  - No data lost: the jobs are idempotent, and the next runs (10:48 hotspot, 10:49 forecast) succeeded.
- **Timeline (UTC):**
  - 10:05:56 and 10:16:43: Cloud Run logs "The request failed because billing is disabled for this project."
  - 10:17–10:46: after billing was restored, submission-service (`/api/v1/corridors`, `/health`) and hotspot-service (`/api/v1/hotspots`, `/health`) returned **HTTP 429** to a ~3/min `curl` probe. Each had latency 0 s and a 14-byte body. Those are Cloud Run front-end rejections while the services re-activated; the application's rate limiter was not involved (it keys on the Firebase uid and returns an ApiError body).
  - Last 429 at 10:46:09. The first successful request was 10:50:18 (alert-service push).
- **Root cause:** the project's billing was disabled, an account-level event outside the project. Services stay 429 for about 30 minutes after it's restored.
- **What changed afterwards:**
  - `monitoring.tf` alerts on 429 bursts, failed job executions and a failing uptime check. Each links this runbook's "429 / billing" and "Service down" sections.
  - A budget alert (opt-in, `billing_account_id`) warns at 50/90/100% before spend becomes a billing problem.
  - Runbook §4 "429 / billing" tells platform 429s apart from app 429s.
- **Follow-up:** confirm what disabled billing (a credit or trial exhaustion vs a payment issue) and keep a backup payment method on the billing account.

### 2026-09-28 — NCR/MH: found in the live rehearsal (two latent bugs)
1. **Citizen reports never reached the heatmap.**
   - hotspot-service's fast-path query failed on every `analysis.completed` with `9 FAILED_PRECONDITION: The query requires an index`, and the events dead-lettered.
   - Cause: a range on `uploadedAt` with no `orderBy` sorts ascending, but only `(h3Index, uploadedAt DESC)` exists.
   - Fixed in the query. The unit-test Firestore fake now enforces the indexes declared in Terraform, so this class of bug fails in CI. It was the second one; Week 1's was the first.
   - **If you see `requires an index` in any log:** it's a query/index mismatch. Fix the query, or declare the index in `firestore.tf`. Don't click the console's "create index" link, because Terraform would then fight it.
2. **The Hosting CDN replayed one user's response to everyone.**
   - A 404 from `GET /api/v1/users/me` was cached for 10 minutes (`X-Cache: HIT`, `Cache-Control: max-age=600`). Its cache key ignores `Authorization`.
   - For those 10 minutes every citizen got "no profile". Registration returned 409 and reports could not be sent.
   - Fixed: every API response is now `Cache-Control: private, no-store`.
   - **Check after any Hosting or API change:** `curl -sI https://<project>.web.app/api/v1/users/me` must show `cache-control: private, no-store` and no `x-cache: HIT`.

### 2026-09-29 — NCR/MH: every citizen report stuck 'queued'
- **Impact:** from the IAM apply on 28 Sep until 29 Sep morning, no report on either state was analysed. The app showed "Reading your photo…" indefinitely.
- **Cause:** the apply made analysis-service private, as the IAM audit intended. Cloud Run's front end then checks each request's OIDC token, and accepts only the service URL or a listed *custom audience* as the addressee. Pub/Sub push tokens are addressed to `vayusetu-analysis-service-<env>`, so every push got **401 before reaching the app**. The app's own logs were empty, and only the request log showed it.
- **Fix:**
  - `custom_audiences` on push-receiving services (`cloud_run.tf`), plus a Terraform guard test.
  - The same setting applied live with `gcloud run services update --add-custom-audiences`.
  - The two stuck reports replayed (see "Dead letters").
  - The result screen now says so after 45 s instead of spinning forever.
- **Check after any IAM change to a push service:** request logs for `/pubsub/*` must show 200/204, not 401/403.

## 6. Earth Engine licence (budget line)

- **Today:** both state projects run under **noncommercial / research registration**, which is free and appropriate for the hackathon pilot.
- **At production:** a state government running VayuSetu operationally is a **commercial/operational use**, which needs a paid Earth Engine subscription per project, or one shared org-level plan.
- **Our footprint:**
  - Five daily exports straight to BigQuery: S5P NO₂ and aerosol index, MAIAC AOD, FIRMS, Sentinel-2 dNBR.
  - The yearly `land-cover` job (Dynamic World, VIIRS, WorldPop).
  - ERA5 daily.
  - Computed at H3 resolution 7, about 5–20k cells per corridor.
  - That is a small number of EECU-hours per day, with no interactive or tile serving. It fits the entry commercial tier.
- **Budget line:** plan **one Earth Engine commercial subscription per state deployment** (or one shared plan if the states contract centrally), at the entry tier's monthly fee plus metered EECU-hours. Prices change, so get a current quote from Google Cloud sales before the procurement request.
- **Until then:** keep `enable_ingestion_schedules` usage within noncommercial terms. No revenue-generating use.
