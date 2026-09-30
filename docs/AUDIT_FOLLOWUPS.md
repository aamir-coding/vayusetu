# Pre-production readiness audit: fixes and follow-ups

Branch `audit/pre-production-readiness`, cut from `phase3/docs-ops`. Nothing on this branch is deployed. Merging it deploys nothing either: CI triggers are off until H4, so every deploy below is a deliberate step.

## What changed

| Finding | Fix | Commit |
|---|---|---|
| **H1** Anonymous accounts can mint "distinct citizens" | Firebase App Check on the 5 citizen write routes. Off by default; `monitor` then `enforce`. Terraform creates the reCAPTCHA Enterprise key behind `enable_app_check`. | c6004b6, c2175f8 |
| **H2** Uploads had no size limit | Signed upload URLs carry `x-goog-content-length-range`: photo 10 MB, audio 2 MB, enforced by Cloud Storage | ab9b282 |
| **H3** Gemini triage could hang until the push deadline | `TRIAGE_TIMEOUT_MS` (25 s) aborts the call | e2e2212 |
| **H4** No CI triggers | Needs a GitHub admin (steps below) | none |
| **M1** Reporter could re-queue analysis without limit | Only `failed` reports, or ones stuck for more than 10 min; at most 3 retries. Officials are uncapped. | 4510f55 |
| **M2** Clarify answer race | Read-check-write in a transaction | 4510f55 |
| **M3** Fast path read every report one by one | One `getAll`, capped at the newest 200 reports | 4913807 |
| **M4** Apps could be framed (clickjacking) | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` | 32ec052 |
| **M5** Citizen media kept forever | `citizen_media_retention_days` Delete rule. Off by default; you choose the days. | c2175f8 |
| **M6** 2 high-severity dependency advisories | undici 6.29.0, fast-uri 3.1.8 (pnpm overrides). The remaining 4 moderate are deferred (see "Deferred"). | b1d1d0a |
| **M7** 73 open NCR alerts, mostly model-only `watch` | `MODEL_ONLY_MIN_SEVERITY` (default `warning`): a cell with zero citizen reports opens an alert only at `warning` or above. Citizen-backed cells are unaffected. | 6f255c7 |
| **M8** Alert push ack deadline of 60 s was shorter than the work | 120 s | c2175f8 |
| **L1** CaptureScreen leaked object URLs and left the mic on | Cleanup reads the latest URLs and stops the recorder and timer | c602f91 |
| **L2** Mock-auth guard trusted `NODE_ENV` alone | Also trips on `K_SERVICE` (always set on Cloud Run) | c602f91 |
| **L3** No `unhandledRejection` handler | Logged as structured ERROR in every service | c602f91 |
| **L4** Duplicate `parseGsUrl` | Shared helper. The duplicated auth plugins are deferred. | e2e2212 |
| **L5** federation `/healthz` | `/health`, with `/healthz` kept as an alias | 891fe4a |
| **L6** `.env.example` gaps | Every `env.ts` key listed with its default | 891fe4a |
| **L7** `CORS_ORIGIN='*'` | Terraform pins it to the citizen + admin Hosting origins | 891fe4a |
| **L8** Dark-mode contrast on Federation metric chips | slate-300 on slate-800 (~10:1) | 891fe4a |
| **L9** Nobody was told when an alert fell back to state level | Log-match alert policy + RUNBOOK "Alert routed to state" | 891fe4a |

Tests: every package's type-check and unit tests pass, Terraform module tests are 45/45, and Playwright E2E is 14/14.

## Deploy order (after you merge)

Every step uses the commands in RUNBOOK §2.1 (Cloud Build) and §2.3 (Terraform plan, approve, apply). Do NCR first, check it, then MH.

1. **citizen-pwa, before submission-service.** The new PWA sends the signed size header. The new submission-service *requires* it, so an old PWA against a new service fails every upload.
2. **submission-service**, then **analysis-service**, **alert-service**, **hotspot-service**, **federation-service**, **forecast-service**, **admin-dashboard**. The admin rebuild also picks up the M4 headers.
3. **Terraform plan/apply** (ncr, then mh). Expect in-place updates only:
   - `alert-service-*` push subscriptions: `ack_deadline_seconds` 60 → 120
   - five Cloud Run services: a new `CORS_ORIGIN` env (new revision), plus `APP_CHECK=off` on submission-service
   - one new alert policy, `alert_fallback_routing`
   - two APIs enabled: `firebaseappcheck`, `recaptchaenterprise`

   **Any replacement or destroy means stop.**

Post-deploy checks, on top of RUNBOOK §2.2:
- Send a normal report from the PWA. The photo and voice note upload and the snapshot appears.
- Oversized upload is rejected. In DevTools, copy an `upload-url` response and PUT an 11 MB file to it with the returned headers. Expect **400 EntityTooLarge** from storage.googleapis.com.
- `curl -s https://federation-service-<env>-….run.app/health` returns `{"ok":true,…}`.
- Over the next day, new NCR alerts should be mostly citizen-backed or `warning`+. The 73 existing open alerts are untouched: dismiss the stale ones in the Alert Queue.

## What you need to do

### H1: turn on App Check (optional, about 20 min, then a day of monitoring)
Cost: reCAPTCHA Enterprise is free for the first 10,000 assessments a month. App Check makes about one assessment per citizen session per hour, far below that at demo scale.

1. In `infra/terraform/environments/ncr/terraform.tfvars`, add:
   ```hcl
   enable_app_check = true
   app_check_mode   = "monitor"
   ```
2. `terraform plan`. Expect: the 2 APIs, `google_recaptcha_enterprise_key.citizen`, `google_firebase_app_check_recaptcha_enterprise_config.citizen`, a new version of the `frontend-env-citizen-pwa` secret, and submission-service `APP_CHECK=monitor`. Apply once you're happy with it.
3. Rebuild and deploy **citizen-pwa**. It picks up `VITE_RECAPTCHA_SITE_KEY` from the secret.
4. Open the PWA and send a report. In Logs Explorer, check that real traffic produces no new `"App Check token missing"` or `"invalid"` warnings for submission-service:
   ```
   resource.labels.service_name="submission-service-ncr-dev" AND jsonPayload.msg=~"App Check token"
   ```
5. After a clean day, set `app_check_mode = "enforce"`, then plan and apply. Scripts without a token now get 401 on register, upload-url, create, clarify and retry.
6. Repeat for mh.

If you ever need to back out: `app_check_mode = "off"` and apply. No redeploy is needed.

### H4: CI triggers (needs a GitHub admin of `aamir-coding/vayusetu`)
1. **Aamir** (repo admin): install the **Google Cloud Build** GitHub App from https://github.com/apps/google-cloud-build, for `aamir-coding/vayusetu` only.
2. In the GCP console for **vayusetu-ncr-dev**: Cloud Build → Triggers → region **global** → *Connect repository* → GitHub (Cloud Build GitHub App) → pick `aamir-coding/vayusetu` → Connect. Skip "create a trigger"; Terraform makes them.
3. Do the same for **vayusetu-mh-dev**.
4. In each environment's `terraform.tfvars`, add:
   ```hcl
   enable_ci_triggers = true
   github_owner       = "aamir-coding"
   github_repo        = "vayusetu"
   ```
5. `terraform plan` from `infra/terraform/environments/ncr`. Expect 2 triggers per app (`<app>-pr-ncr-dev`, `<app>-main-ncr-dev`) and nothing else. Apply, then do the same for mh.
6. Test it: open a small PR. Only the touched apps should run a validate-only build.

Cost note: every merge to main then builds and deploys the touched apps in **both** states. Cloud Build's free tier is 2,500 build-minutes a month, and a full-monorepo change costs roughly 9 apps × 2 states × 4–6 min.

### M5: media retention (a policy decision)
Choose how long raw photos and voice notes are kept. The analysis, severity, location and history stay in Firestore and BigQuery regardless. Suggested: **90 days**, which covers a GRAP season's investigations. Minimum 30.
```hcl
citizen_media_retention_days = 90
```
Then plan and apply. **Deletion is permanent**, and on first apply it removes every object already older than N days.

### M8, L7, L9
These are in the same Terraform apply as deploy step 3. There's nothing extra to set.

## Deferred (not fixed here, on purpose)
- **react-router 6 → 7** (2 moderate advisories: open redirect via backslash in `<Link>`, `deserializeErrors`). Both apps only link to their own hard-coded routes and don't use the data-router SSR path. A major upgrade isn't worth the risk before submission.
- **uuid 9** inside `gaxios`: the advisory needs a caller-supplied `buf`, and nothing passes one.
- **L4 remainder:** the Firebase auth plugins in hotspot, forecast and federation are near-duplicates. Merging them into `gcp-clients` is a refactor with no behaviour change, better done after submission.
- **firestore-rules tests** could not run in this session: the Firestore emulator and Vitest ran out of memory (Windows commit limit, about 1.3 GB free). This branch does not touch the rules. Run `pnpm --filter @vayusetu/firestore-rules test` on a machine with free RAM before merging.
