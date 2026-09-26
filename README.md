# VayuSetu

Federated, AI-powered air-quality early-warning platform for hyperlocal pollution detection and forecasting. Built for the Google Cloud Hackathon, Track B: Clean Air & Climate Resilience.

Full product/architecture context lives in `docs/context/` (see `00_PROJECT_INDEX.md` first) and `docs/PRD_AND_ARCHITECTURE.md`.

## Quickstart

```bash
corepack enable
pnpm install
pnpm dev            # runs every app's dev script in parallel via turbo
```

- Citizen PWA: http://localhost:5173
- Admin Dashboard: http://localhost:5174

**No environment variables are required to run either app.** Both ship in mock mode by default: [MSW](https://mswjs.io) intercepts every REST call against the exact shapes in `API_CONTRACTS.md`, and Firebase Auth is replaced by an in-memory/localStorage stand-in (see each app's `.env.example` and `src/lib/firebase.ts`). This is deliberate — Engineer 1's frontend work is never blocked on the other three engineers' services landing.

- **Citizen PWA**: opens straight into report capture, no login wall (silent anonymous auth). Tap **Verify** in the header to try the phone-OTP flow — mock OTP is `123456`.
- **Admin Dashboard**: sign-in screen offers two personas — Officer Deshmukh (district_admin) and Ms. Iyer (state_admin) — since real accounts are provisioned out-of-band per the contract, not self-registered.

## Submission API local test

The submission service uses local Firestore and Pub/Sub emulators. Run each step in a separate terminal and keep the emulator and API terminals running. The service scripts do not automatically load `apps/submission-service/.env.local`, so set the variables shown below.

### Bash

**Terminal 1 — start emulators from the repository root:**

```bash
./infra/scripts/dev-emulators.sh
```

**Terminal 2 — create Pub/Sub topics and debug subscriptions:**

```bash
cd apps/submission-service
export PUBSUB_EMULATOR_HOST=localhost:8085
export GOOGLE_CLOUD_PROJECT=vayusetu-ncr-dev
pnpm emulator:topics
```

**Terminal 3 — start the API:**

```bash
cd apps/submission-service
export AUTH_MODE=mock
export NODE_ENV=development
export PORT=8080
export GOOGLE_CLOUD_PROJECT=vayusetu-ncr-dev
export FIRESTORE_EMULATOR_HOST=localhost:8081
export PUBSUB_EMULATOR_HOST=localhost:8085
pnpm dev
```

**Terminal 4 — exercise the API:**

```bash
curl http://localhost:8080/health

curl -X POST http://localhost:8080/api/v1/users/register \
	-H "Authorization: Bearer mock-token:rina-test" \
	-H "Content-Type: application/json" \
	-d '{"displayName":"Rina","preferredLanguage":"hi-IN","role":"citizen"}'

curl http://localhost:8080/api/v1/users/me \
	-H "Authorization: Bearer mock-token:rina-test"

curl -X POST http://localhost:8080/api/v1/submissions \
	-H "Authorization: Bearer mock-token:rina-test" \
	-H "Content-Type: application/json" \
	-d '{"mediaType":"photo","photoStorageUrl":"https://storage.googleapis.com/example/photo.jpg","geo":{"lat":28.6129,"lng":77.2295},"capturedAt":"2026-09-10T10:00:00.000Z"}'

curl "http://localhost:8080/api/v1/submissions?pageSize=10" \
	-H "Authorization: Bearer mock-token:rina-test"

gcloud config set api_endpoint_overrides/pubsub http://localhost:8085/
gcloud pubsub subscriptions pull \
	submission.created-debug-pull --auto-ack --project=vayusetu-ncr-dev

# Run this after local emulator testing to restore real GCP Pub/Sub commands.
gcloud config unset api_endpoint_overrides/pubsub
```

### PowerShell

**Terminal 1 — start emulators from the repository root:**

```powershell
bash ./infra/scripts/dev-emulators.sh
```

**Terminal 2 — create Pub/Sub topics and debug subscriptions:**

```powershell
cd apps/submission-service
$env:PUBSUB_EMULATOR_HOST="localhost:8085"
$env:GOOGLE_CLOUD_PROJECT="vayusetu-ncr-dev"
pnpm emulator:topics
```

**Terminal 3 — start the API:**

```powershell
cd apps/submission-service
$env:AUTH_MODE="mock"
$env:NODE_ENV="development"
$env:PORT="8080"
$env:GOOGLE_CLOUD_PROJECT="vayusetu-ncr-dev"
$env:FIRESTORE_EMULATOR_HOST="localhost:8081"
$env:PUBSUB_EMULATOR_HOST="localhost:8085"
pnpm dev
```

The API log should contain `authMode=mock`. **Terminal 4 — exercise the API:**

```powershell
Invoke-RestMethod -Uri "http://localhost:8080/health"

$body = @{ displayName = "Rina"; preferredLanguage = "hi-IN"; role = "citizen" } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://localhost:8080/api/v1/users/register" -Method Post -Headers @{ Authorization = "Bearer mock-token:rina-test" } -ContentType "application/json" -Body $body

Invoke-RestMethod -Uri "http://localhost:8080/api/v1/users/me" -Headers @{ Authorization = "Bearer mock-token:rina-test" }

$body = @{ mediaType = "photo"; photoStorageUrl = "https://storage.googleapis.com/example/photo.jpg"; geo = @{ lat = 28.6129; lng = 77.2295 }; capturedAt = "2026-09-10T10:00:00.000Z" } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://localhost:8080/api/v1/submissions" -Method Post -Headers @{ Authorization = "Bearer mock-token:rina-test" } -ContentType "application/json" -Body $body

Invoke-RestMethod -Uri "http://localhost:8080/api/v1/submissions?pageSize=10" -Headers @{ Authorization = "Bearer mock-token:rina-test" }

$env:PUBSUB_EMULATOR_HOST="localhost:8085"
gcloud config set api_endpoint_overrides/pubsub http://localhost:8085/
gcloud pubsub subscriptions pull submission.created-debug-pull --auto-ack --project=vayusetu-ncr-dev

# Run this after local emulator testing to restore real GCP Pub/Sub commands.
gcloud config unset api_endpoint_overrides/pubsub
```

If the emulator terminal is stopped and restarted, rerun `pnpm emulator:topics` before submitting another report. The emulator does not persist topics, subscriptions, or messages between restarts.

## What's here

| Path | Owner | Status |
|---|---|---|
| `packages/shared-types` | Engineer 2 | Canonical, byte-identical to `API_CONTRACTS.md` §4.1 |
| `packages/config` | Engineer 1 | Shared Tailwind design tokens (brand, AQI/severity/GRAP color ramps, type scale) |
| `packages/ui-components` | Engineer 1 | shadcn/ui-style component library, typed against `shared-types` |
| `apps/citizen-pwa` | Engineer 1 | Feature 1 (Snap & Sense) — capture, snapshot result, my reports, phone auth, offline queue, 4-language i18n |
| `apps/admin-dashboard` | Engineer 1 | Alert queue, hotspot map, forecast view, Federation panel, Lite Mode |
| `apps/submission-service` | Engineer 2 | Week 1 scaffold and Users/Submissions API; local emulator-tested |
| `apps/alert-service` | Engineer 2 | Live: severity, routing, FCM, Pipeline C guard layer |
| `apps/federation-service` | Engineer 2 | Built + tested; deploy pending the Exchange project |
| `apps/ingestion-jobs` | Engineer 4 | Python Cloud Run Jobs: CPCB, Air Quality API, Weather API, Earth Engine, rollup, seed, migrate (`python -m vayusetu_ingest --help`) |
| `analysis-service`, `hotspot-service`, `forecast-service`, `packages/gemini-client`, `ml/` | (Engineer 3 scope) | Phase 1 of `docs/EXECUTION_PLAN.md` |

## Where we are

`docs/EXECUTION_PLAN.md` is the live plan: technology decisions, phases and the console steps that need an account owner.

## Commands

Standard turbo-orchestrated scripts from the repo root: `pnpm build`, `pnpm dev`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm format`. `pnpm test` includes the Python ingestion tests once `apps/ingestion-jobs/.venv` exists (`python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt`). Frontends run on MSW mocks by default; set `VITE_USE_MOCKS=false` in `apps/<app>/.env.local` to use real services through the dev proxy. On Windows run `git config core.longpaths true` once. Scope any of these to one app with `pnpm --filter @vayusetu/citizen-pwa <script>`.

## Terraform and secrets

Terraform configuration lives in `infra/terraform`. The NCR development environment has been applied to project `vayusetu-ncr-dev`; the generated `tfplan`, Terraform state, `.tfvars`, and credentials are intentionally ignored by Git.

Terraform creates empty Secret Manager containers only. Add real values out-of-band with `gcloud secrets versions add`; never put API keys in Terraform files, `.env` files committed to Git, or frontend code. The deployed Cloud Run services initially use the public `hello` placeholder until each real service image is deployed.

When using Pub/Sub emulator commands with `gcloud`, set the local endpoint first:

```powershell
gcloud config set api_endpoint_overrides/pubsub http://localhost:8085/
gcloud pubsub subscriptions pull submission.created-debug-pull --auto-ack --project=vayusetu-ncr-dev
gcloud config unset api_endpoint_overrides/pubsub
```

## Contract gaps found while building the frontend

Flagged in code (search `contract gap` isn't literal — see comments in `apps/citizen-pwa/src/lib/apiClient.ts` and `src/hooks/useAuth.tsx`) rather than silently worked around:

1. **Field-worker sensor reading has nowhere to go.** Product Spec Feature 1 lists an optional PM2.5/PM10 reading as a Persona 2 input, but `POST /submissions`'s request body in `API_CONTRACTS.md` §4.2 doesn't include it. Currently captured client-side and held in the offline-queue shape only; not sent to the server.
2. **`role` can't be changed after registration.** `PATCH /users/me` only allows `displayName` / `preferredLanguage` / `fcmTokens`. A citizen who registers anonymously can't later "become" a field worker through the API as specified — worked around by asking the field-worker question *before* first registration (during phone verification), not by inventing a client-side role upgrade.

Both are one-line additions to `packages/shared-types` if the team wants them — flagging for whoever owns that conversation rather than deciding unilaterally.
