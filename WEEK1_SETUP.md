# Engineer 2 — Week 1 Setup Guide

Scope, per `docs/context/06_TEAM_ROLES_AND_REPO_MAP.md`: `packages/shared-types` (verify), `packages/gcp-clients` (build), `apps/submission-service` (scaffold against Users/Submissions), Pub/Sub topics, and the Terraform module for a full state deployment.

## 0. Merge this into your repo

Everything in this archive extracts directly onto your existing monorepo root:

```bash
unzip vayusetu-engineer2-week1.zip -d /path/to/your/vayusetu/repo
cd /path/to/your/vayusetu/repo
```

It adds `packages/gcp-clients/`, `apps/submission-service/`, `infra/`, and this file. It does **not** touch `packages/shared-types` (already correct in your repo — see §1), `apps/citizen-pwa`, or `apps/admin-dashboard`.

## 1. Verify shared-types first (it's already done)

`packages/shared-types/src/index.ts` in your repo is already byte-identical to `API_CONTRACTS.md` §4.1 — nothing to change. Confirm it still builds cleanly before building anything on top of it:

```bash
pnpm install
pnpm --filter @vayusetu/shared-types build
```

If this fails, stop here — everything downstream depends on it, and per the PRD it's meant to be "the first PR merged on the project, before any other app code."

## 2. Install the new packages' dependencies

```bash
pnpm install   # picks up gcp-clients + submission-service automatically via pnpm-workspace.yaml
pnpm --filter @vayusetu/gcp-clients type-check
pnpm --filter @vayusetu/submission-service type-check
pnpm --filter @vayusetu/submission-service lint
```

All four should be clean — this exact sequence is what I ran to validate before handing this off (see the design notes below for what that caught).

## 3. Stand up GCP infra

Full walkthrough with expected resource counts and a Terraform-specific troubleshooting table: **`infra/terraform/README.md`**. Short version:

```bash
gcloud projects create vayusetu-ncr-dev --name="VayuSetu NCR Dev"
gcloud billing projects link vayusetu-ncr-dev --billing-account=YOUR_BILLING_ACCOUNT_ID
gcloud config set project vayusetu-ncr-dev
gcloud auth application-default login

cd infra/terraform/environments/ncr
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform validate && terraform plan -out=tfplan
terraform apply tfplan
terraform output   # save service_account_emails + cloud_run_urls somewhere
```

Run `terraform validate` as the first step before `plan`/`apply`; if anything's off it will identify the resource or argument. The generated `tfplan`, Terraform state, `terraform.tfvars`, and crash logs are ignored by Git and must not be committed.

## 4. Local dev loop (no real GCP needed for this part)

**One-time:**
```bash
gcloud components install cloud-firestore-emulator pubsub-emulator
cd apps/submission-service
cp .env.example .env.local
```

**Every time you work on this service** — three terminals:

```bash
# Terminal 1: emulators
./infra/scripts/dev-emulators.sh

# Terminal 2: create the Pub/Sub topics in the emulator (it doesn't persist between restarts)
cd apps/submission-service
PUBSUB_EMULATOR_HOST=localhost:8085 GOOGLE_CLOUD_PROJECT=vayusetu-ncr-dev pnpm emulator:topics

# Terminal 3: the service itself
cd apps/submission-service
pnpm dev
```

You should see:
```
submission-service listening on :8080 (project=vayusetu-ncr-dev, authMode=mock)
```

`AUTH_MODE=mock` (set in `.env.local` from the example) means it accepts `Authorization: Bearer mock-token:<any-uid>` — the exact scheme `apps/citizen-pwa`'s MSW mocks already use. `index.ts` hard-refuses to boot with `AUTH_MODE=mock` if `NODE_ENV=production`, so this can't accidentally ship.

## 5. Exercise the API

```bash
# Health check — no auth needed
curl http://localhost:8080/health

# Register a citizen
curl -X POST http://localhost:8080/api/v1/users/register \
  -H "Authorization: Bearer mock-token:rina-test" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Rina","preferredLanguage":"hi-IN","role":"citizen"}'

# Fetch that profile back
curl http://localhost:8080/api/v1/users/me \
  -H "Authorization: Bearer mock-token:rina-test"

# Submit a report (photoStorageUrl just needs to be a syntactically valid URL for Week 1 —
# the real signed-upload flow is submission-service's own future lib/, not built this week)
curl -X POST http://localhost:8080/api/v1/submissions \
  -H "Authorization: Bearer mock-token:rina-test" \
  -H "Content-Type: application/json" \
  -d '{
    "mediaType": "photo",
    "photoStorageUrl": "https://storage.googleapis.com/example/photo.jpg",
    "geo": {"lat": 28.6129, "lng": 77.2295},
    "capturedAt": "2026-09-10T10:00:00.000Z"
  }'

# List "my" submissions
curl "http://localhost:8080/api/v1/submissions?pageSize=10" \
  -H "Authorization: Bearer mock-token:rina-test"
```

The submission response's `jurisdiction` will be your `.env.local` defaults (`DL`/`DL-CENTRAL`) unless you've set a real `GOOGLE_MAPS_API_KEY`, and `h3Index` will be a real resolution-8 H3 cell computed from the lat/lng yousent (verified against real coordinates — see design notes).

## 6. Verify the Pub/Sub publish actually happened

```bash
gcloud pubsub subscriptions pull submission.created-debug-pull \
  --auto-ack --project=vayusetu-ncr-dev
# (against the LOCAL emulator instead, if that's what you're running against:)
gcloud config set api_endpoint_overrides/pubsub http://localhost:8085/
gcloud pubsub subscriptions pull \
  submission.created-debug-pull --auto-ack --project=vayusetu-ncr-dev
gcloud config unset api_endpoint_overrides/pubsub
```

You should see one message per submission you created, with data `{"submissionId":"..."}` — nothing more (see the "thin reference" design rule in `packages/gcp-clients/src/pubsub.ts`).

## 7. Debugging reference

| Symptom | Likely cause | Fix |
|---|---|---|
| Service won't boot: `❌ Invalid environment configuration` | A required env var is missing/malformed | The printed list tells you exactly which key+why (Zod's issue list) — usually `GOOGLE_CLOUD_PROJECT` unset |
| Every request 401s even with a `mock-token:` header | `.env.local` wasn't loaded, or you're running with realenv vars from a parent shell overriding it, or `AUTH_MODE` isn't actually `mock` | `curl http://localhost:8080/health` doesn't need auth — check that first to confirm the server itself is up, then `echo $AUTH_MODE` in the terminal you launched `pnpm dev` from |
| `POST /submissions` fails with `Register before submitting a report` | Working as designed — call `POST /users/register` for that uid first, exactly like `citizen-pwa`'s `ensureRegistered()` does before its first real submission |
| Requests hang, then fail with `Could not load the default credentials` | No Firestore emulator running (or `FIRESTORE_EMULATOR_HOST` not set) and no real ADC either | Start `infra/scripts/dev-emulators.sh`, confirm `.env.local` has `FIRESTORE_EMULATOR_HOST=localhost:8081`; for real GCP instead, run `gcloud auth application-default login` |
| `publishEvent` throws `Failed to publish to Pub/Sub topic` | Either the emulator has no topics yet (it doesn't persist across restarts) or a real deploy's topic doesn't exist / the service account lacks `roles/pubsub.publisher` | Re-run `pnpm emulator:topics`, or check `terraform output pubsub_topics` / the service account's IAM bindings |
| Firestore query throws `FAILED_PRECONDITION: The query requires an index` | A composite index this exact query needs isn't provisioned | Check it's one of the five in `infra/terraform/modules/state-deployment/firestore.tf`; if it's a genuinely new query shape, add it there rather than one-off clicking the console link Firestore's error gives you |
| `pnpm install` fails inside the Docker build | Dockerfile's `deps` stage only copies `package.json` files (for layer caching), not lockfile changes made after that layer was built | `docker build --no-cache ...`, or make sure `pnpm-lock.yaml` is current (`pnpm install` at the repo root) before building the image |
| Two engineers' `terraform apply` conflict / overwrite each other | Local state (default) isn't shared | Standup a GCS state bucket and uncomment the `backend "gcs"` block in `infra/terraform/environments/ncr/providers.tf` — do this **before** a second person runs `apply`, not after |
| curl to a freshly-deployed Cloud Run URL gets a browser HTML error page, not JSON | You hit the Cloud Run **project** URL, not the assigned URL, or the manual `hello` placeholder is still deployed (haven't done the manual-deploy step in `infra/terraform/README.md` yet) | `terraform output cloud_run_urls`, and confirm you deployed areal image over the placeholder |

## Design notes (the "why" behind a few choices)

- **`AUTH_MODE=mock`** — lets `apps/citizen-pwa` point `VITE_API_BASE_URL` at this *real* service before Firebase Auth is wired end-to-end, using the exact `mock-token:<uid>` scheme its own MSW handlers already use. Hard-blocked from `NODE_ENV=production` in `index.ts`.
- **`h3-js` used directly in `submission-service`, not `@vayusetu/h3-utils`** — that package is Engineer 4's Week 1 deliverable and doesn't exist yet. Flagged in `src/lib/h3.ts` as a contract gap to resolve the moment it lands, matching this repo's existing "flag it in code" convention (see the root `README.md`'s "Contract gaps found" section).
- **`resolveJurisdiction()` falls back to a configured default when `GOOGLE_MAPS_API_KEY` is unset** — mirrors `isFirebaseConfigured` throughout the frontend: the service should be runnable end-to-end on day one without every engineer needing a Maps key yet, but this must never be silent in a real deployment (it logs a warning every time the fallback path is used).
- **Pub/Sub topic names use dots (`submission.created`)** — GCP allows periods in topic ids, so the Terraform resource names and the TypeScript `PubSubEventMap` keys are identical strings, not a lossy dash/dot translation that could drift.
- **Every Cloud Run service is public (`allUsers` invoker) in Week 1** — intentionally permissive; `TEAM_ROLES_AND_REPO_MAP.md` already scopes a security/IAM audit for Week 4, and tightening ingress per-service belongs there, not improvised now.
- **Validated, not just written** — before this was handed to you, `pnpm type-check` passed clean across `shared-types`/`gcp-clients`/`submission-service`, `eslint` was clean, `h3-js`'s resolution was checked against a realDelhi coordinate, `jurisdictionContains` was checked against all four state/district combinations, and the liveserver was booted and hit with `curl` for the healthz-bypass, missing-auth, bad-mock-token, validation-error, and Firestore-failure paths — all five came back exactly as designed. I could **not** validate the Terraform (no `terraform` binary available to me) — that's the one piece you should `terraform validate` before trusting fully.

## What's next (Week 2, not built here — don't pull it forward)

Per `TEAM_ROLES_AND_REPO_MAP.md`: finish `submission-service`'s remaining polish, scaffold `alert-service` subscribing to `hotspot.updated`/`forecast.updated` (still mocked upstream), build the channel-abstracted notification gateway (FCM live, SMS/WhatsApp stubbed behind the same interface), and wire Cloud Build CI/CD path-triggeredper app. The Dockerfile here is ready for that; the actual `cloudbuild.yaml` files are deliberately not included this week.