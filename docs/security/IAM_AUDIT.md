# IAM least-privilege audit — state deployments

- **Date:** 27 Sep 2026
- **Scope:** `infra/terraform/modules/state-deployment/*.tf`, which defines every state project (NCR `vayusetu-ncr-dev`, Mumbai-Pune `vayusetu-mh-dev`), plus `modules/exchange`.
- **Method:** read-only review of every `*_iam_member` grant, checked against what each service's code actually calls:
  - `packages/gcp-clients`: Firestore, Pub/Sub, Storage signing and Auth token verification
  - each service's adapters
  - the predefined roles' permission lists (`gcloud iam roles describe`).
- **Result:** 9 findings.
  - The changes for findings 1–7 are in code on `phase3/docs-ops` and tested (`terraform test`: 28/28, including the 6 new guards in `tests/iam.tftest.hcl`).
  - Findings 8–9 are accepted and documented below.
  - **Nothing has been applied yet.** See "Rollout" at the end.

## Findings

| # | Severity | Principal | Before | After | Why it matters |
|---|---|---|---|---|---|
| 1 | **High** | submission-service | `roles/iam.serviceAccountTokenCreator` at **project** level | Token Creator on **its own SA only** (`submission_signs_as_itself`) | It needs `signBlob` as itself for V4 signed upload/read URLs. The project grant let it mint tokens for *every* SA in the project, including the Cloud Build deployer (actAs on all runtime SAs) and ml-pipelines. A single RCE in the most internet-exposed service became project takeover. |
| 2 | **High** | alert-service | `roles/firebase.admin` | `roles/firebasecloudmessaging.admin` | It only sends FCM (`cloudmessaging.messages.create`); ID-token verification needs no IAM. `firebase.admin` includes Auth user management (create, delete or set claims on any user, and so promote itself to super_admin), Hosting releases and Rules. |
| 3 | **High** | federation-service | `roles/aiplatform.admin` + project `roles/storage.objectAdmin` | `roles/aiplatform.user`; storage role removed | `aiplatform.user` already has what Model Registry copy/import needs (`models.get/list/upload/export/update`, `modelEvaluations.list`). The service never touches Cloud Storage. Admin could delete every model, endpoint and pipeline. |
| 4 | Medium | analysis-service | `allUsers` → `roles/run.invoker` | removed; only `pubsub-push` invokes it (`analysis_push_invoker`) | It has no public routes. The app verifies the push OIDC token, but anonymous callers still reached the container and cost money. |
| 5 | Medium | submission-, analysis-service | project `storage.objectAdmin` / `storage.objectViewer` | bucket-level: submission → objectAdmin on `citizen-media`, objectViewer on `advisory-audio` (it signs read URLs *as itself*); analysis → objectViewer on `citizen-media` (its writes were already bucket-scoped) | Project storage roles covered `model-artifacts`, the Terraform `reference` bucket and the Cloud Build source bucket. |
| 6 | Medium | submission-, analysis-, alert-service | project `secretmanager.secretAccessor` | secret-level: `google-maps-api-key` for all three; `sms-gateway-credentials` and `whatsapp-gateway-credentials` for alert-service only | Every service could read every secret (OpenAQ, CPCB, both SMS/WhatsApp gateways). Secrets reach containers via `secretKeyRef`, which checks exactly this binding. |
| 7 | Low | all publishing/subscribing services; hotspot, forecast, federation, analysis | project `pubsub.publisher`, `pubsub.subscriber`, `bigquery.dataEditor` / `dataViewer` | publisher on **their own topic** only (API_CONTRACTS.md §4.3); **no** subscriber role (every subscription is push, and push delivery needs none); BigQuery data roles on the **`core` dataset** only (batch predictions also land in `core`) | Any service could publish forged events on any topic (e.g. fake `hotspot.updated` → alerts), or write any dataset, including the local `federation_exchange`. |
| 8 | Accepted | submission, alert, hotspot, forecast, federation | `allUsers` → `run.invoker` | unchanged | **Required:** Firebase Hosting rewrites call Cloud Run unauthenticated. Every route verifies a Firebase ID token (`plugins/auth.ts`) and enforces jurisdiction. Compensating controls: per-service rate limits (`@fastify/rate-limit`) and the monitoring alerts in `monitoring.tf`. |
| 9 | Accepted | ml-pipelines SA; Vertex AI service agent | project `bigquery.dataEditor` + `jobUser` | unchanged | AutoML training (run as the Vertex agent) creates its own temporary export datasets in the project, whose names aren't known ahead of time. A dataset-scoped grant would break training. Both identities are non-interactive and can't be impersonated by any service (finding 1 closes that path). |

### Reviewed and fine as is
- **Cloud Build deployer:**
  - Project roles: `run.developer`, `artifactregistry.writer`, `logging.logWriter`, `firebasehosting.admin`, `serviceUsageConsumer`.
  - `actAs` is granted per runtime SA, not project-wide (`cloudbuild_act_as_runtime`).
  - Secret access is limited to the two `frontend-env-*` secrets.
- **Scheduler SA:** `run.invoker` on each job individually.
- **Ingestion SA:** secret-level accessors, and objectAdmin on the reference bucket only. `earthengine.writer` is needed for export tasks.
- **Pub/Sub service agent:**
  - Token Creator on the `pubsub-push` SA only (the standard OIDC push setup).
  - Publisher on the dead-letter topics only.
- **The Exchange (`modules/exchange`):**
  - States get dataset-level `dataEditor` and project `aiplatform.user`.
  - The importing state's Vertex agent gets `aiplatform.viewer`.
- **Firestore:** `roles/datastore.user` is the narrowest predefined role. Per-collection limits for *clients* are in `firestore.rules`.

### Follow-ups (not IAM bindings)
- **Firebase web-app API keys**, auto-created by `google_firebase_web_app`, are unrestricted by API. Restrict them to Identity Toolkit, Firestore, FCM Registrations and Installations, as `maps.tf` already does for the Maps key.
- **Cloud Run ingress:** it stays `INGRESS_TRAFFIC_ALL`, because Hosting rewrites arrive from the internet. analysis-service could be `INTERNAL_ONLY`, since Pub/Sub push from the same project counts as internal. This is left for a separate change so the IAM rollout has one variable.

## Rollout
1. Apply requires Chirag's approval (a permanent rule). Each environment's plan should show only these IAM additions and removals, plus the removal of analysis-service's `allUsers` binding.
2. Apply in a quiet window. Terraform creates the scoped grants and deletes the project grants in the same run, so a request in flight can hit a gap of a few seconds.
3. Smoke test after each environment (RUNBOOK.md, "Post-deploy smoke"):
   - Upload URL plus report submission: exercises signing, citizen-media and `submission.created`.
   - The analysis result and TTS link: exercises analysis-service's bucket, secret and topic grants, plus the advisory-audio read.
   - One `hotspot-score-hourly` execution: exercises the `core` dataEditor grant.
   - An alert push: exercises FCM.
4. If a permission is missing, the service logs `PERMISSION_DENIED` with the exact permission. The "5xx rate" alert in `monitoring.tf` fires. Re-add the narrowest role on the named resource, never the old project-level role.
