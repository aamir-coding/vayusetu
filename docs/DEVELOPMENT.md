# VayuSetu: developer guide

How to run, test and deploy VayuSetu. For what it is and why it matters, see the [README](../README.md). Operations are covered in [RUNBOOK.md](RUNBOOK.md), and the demo in [DEMO.md](DEMO.md).

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

## Commands

Standard turbo-orchestrated scripts from the repo root: `pnpm build`, `pnpm dev`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm format`. `pnpm test` includes the Python ingestion tests once `apps/ingestion-jobs/.venv` exists (`python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt`). Frontends run on MSW mocks by default; set `VITE_USE_MOCKS=false` in `apps/<app>/.env.local` to use real services through the dev proxy. On Windows run `git config core.longpaths true` once. Scope any of these to one app with `pnpm --filter @vayusetu/citizen-pwa <script>`.

## Terraform and secrets

Terraform configuration lives in `infra/terraform`. The NCR development environment has been applied to project `vayusetu-ncr-dev`; the generated `tfplan`, Terraform state, `.tfvars`, and credentials are intentionally ignored by Git.


When using Pub/Sub emulator commands with `gcloud`, set the local endpoint first:

```powershell
gcloud config set api_endpoint_overrides/pubsub http://localhost:8085/
gcloud pubsub subscriptions pull submission.created-debug-pull --auto-ack --project=vayusetu-ncr-dev
gcloud config unset api_endpoint_overrides/pubsub
```

## Deploying

Each service and web app deploys with Cloud Build (`infra/cloudbuild/<app>.yaml`), and the steps are in [RUNBOOK.md §2](RUNBOOK.md). Terraform state lives in a versioned GCS bucket per environment (see [infra/terraform/README.md](../infra/terraform/README.md#remote-state)).
