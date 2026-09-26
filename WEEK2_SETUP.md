# Engineer 2 — Week 2 Setup Guide

Week 2 scope (TEAM_ROLES_AND_REPO_MAP.md): `submission-service` fully implements its contract incl. Geocoding-based jurisdiction resolution · `alert-service` skeleton on (mocked) `hotspot.updated`/`forecast.updated` · channel-abstracted notification gateway, FCM live, SMS/WhatsApp stubbed · Cloud Build CI/CD path-triggered per app.

---

## 0. Apply the delta

From the repo root:

```bash
git apply --check vayusetu-engineer2-week2.patch && git apply vayusetu-engineer2-week2.patch
pnpm install                              # REQUIRED: adds alert-service + vitest to pnpm-lock.yaml.
git add pnpm-lock.yaml                    # CI and the Dockerfiles use --frozen-lockfile and fail without it.
terraform fmt -recursive infra/terraform  # fixes whitespace drift Week 1 left in bigquery.tf / iam.tf
```

If `git apply --check` rejects `.dockerignore`, your repo already has a root one — merge the lines from `files/.dockerignore` by hand. Deleted by the patch: `apps/submission-service/.dockerignore`, `apps/submission-service/test/fakeFirestore.ts` (see §5, bug 7, and the shared fake below).

## 1. Verify before touching GCP

```bash
pnpm --filter @vayusetu/shared-types build
for p in @vayusetu/gcp-clients @vayusetu/submission-service @vayusetu/alert-service; do
  pnpm --filter $p type-check && pnpm --filter $p test || break
done
pnpm --filter @vayusetu/submission-service lint && pnpm --filter @vayusetu/alert-service lint

# Terraform plan-level tests -- mock providers, NO credentials needed (Terraform >= 1.7)
cd infra/terraform/modules/state-deployment && terraform init -backend=false && terraform test && cd -
```

Expected: gcp-clients **11**, submission-service **31**, alert-service **42** tests; Terraform **5** runs pass.

## 2. Local dev loop (emulators, no real GCP)

```bash
# T1 -- emulators (Week 1 script)
./infra/scripts/dev-emulators.sh

# T2 -- one-time per emulator start (it persists nothing)
export PUBSUB_EMULATOR_HOST=localhost:8085 FIRESTORE_EMULATOR_HOST=localhost:8081 GOOGLE_CLOUD_PROJECT=vayusetu-ncr-dev
pnpm --filter @vayusetu/submission-service emulator:topics
pnpm --filter @vayusetu/alert-service seed:dev              # corridors + mock-deshmukh / mock-iyer

# T3 -- alert-service (cp .env.example .env first)
cd apps/alert-service && node --env-file=.env --import tsx src/index.ts

# T2 again -- point emulator push subscriptions at T3
pnpm --filter @vayusetu/alert-service emulator:subscriptions
```

Fire mocked upstream events (this script is the stand-in for hotspot-service/forecast-service until Engineer 3 publishes for real):

```bash
cd apps/alert-service
node scripts/mock-event.mjs hotspot --score 0.92            # critical -> push (stub) + sms/whatsapp (stub) logs in T3
node scripts/mock-event.mjs hotspot --score 0.92            # same cell, same hour -> duplicate, nobody re-paged
node scripts/mock-event.mjs forecast --aqi 420              # one state-level alert per NCR state (DL, HR, UP, RJ)
node scripts/mock-event.mjs hotspot --score 0.3             # below threshold -> acked, no alert
# If the emulator's push delivery misbehaves, add --direct (POSTs the envelope straight to T3).
```

Act on them as the dashboard would:

```bash
A=http://localhost:8082/api/v1
curl -s $A/alerts -H 'authorization: Bearer mock-token:mock-deshmukh' | jq '.totalCount, [.items[].id]'
curl -s $A/alerts -H 'authorization: Bearer mock-token:mock-iyer'     | jq '[.items[] | {id, assignedJurisdiction}]'
ID=$(curl -s $A/alerts -H 'authorization: Bearer mock-token:mock-deshmukh' | jq -r '.items[0].id')
curl -s -X PATCH "$A/alerts/$ID/status" -H 'authorization: Bearer mock-token:mock-deshmukh' \
  -H 'content-type: application/json' -d '{"status":"acknowledged","note":"Team dispatched"}' | jq '.statusHistory'
curl -s -X PATCH "$A/alerts/$ID/status" -H 'authorization: Bearer mock-token:mock-deshmukh' \
  -H 'content-type: application/json' -d '{"status":"new"}' | jq '.error'            # 409 CONFLICT
```

Deshmukh (DL-CENTRAL) sees district alerts only; Iyer (DL state) also sees the state-level forecast alert.

## 3. Cloud rollout — in this order

Each Terraform flag defaults to the safe/off state. Flip them in `environments/ncr/terraform.tfvars` one step at a time.

| # | Do | Why this order |
|---|---|---|
| 1 | `terraform apply` with defaults | FCM APIs, new Firestore indexes, push SA, dead-letter topic, CI deployer SA, per-service env. Indexes take minutes to build — check `gcloud firestore indexes composite list`. |
| 2 | `gcloud secrets versions add google-maps-api-key --data-file=- <<< "AIza..."` → `maps_api_key_secret_populated = true` → apply | Cloud Run refuses to deploy a revision referencing a secret with zero versions. Restrict the key to the Geocoding API. |
| 3 | Install the **Google Cloud Build** GitHub App on the repo; Console → Cloud Build → Triggers → *Connect repository* (region: global) → set `enable_ci_triggers = true`, `github_owner`, `github_repo` → apply | 1st-gen GitHub connections can't be Terraformed. Applying before connecting fails. |
| 4 | First deploy: merge to `main` (or `gcloud builds submit --config infra/cloudbuild/alert-service.yaml --substitutions=_DEPLOY=true .` and same for submission-service) | Replaces the Week 1 hello-world placeholder with real images. |
| 5 | `enable_alert_push_subscriptions = true` → apply | **Only after step 4.** The placeholder answers every push with 200; Pub/Sub treats that as an ack and real events are silently lost. |
| 6 | `node apps/alert-service/scripts/provision-official.mjs --email <officer> --role district_admin --state DL --district DL-CENTRAL --yes` | Writes custom claims + `users/{uid}` together. Officer must sign out/in for claims to apply. |
| 7 | Engineer 1: Firebase console → Cloud Messaging → Web Push certificate (VAPID key) → dashboard calls `getToken()` and `PATCH /api/v1/users/me {fcmTokens}` | FCM has no emulator; a real token is the only way to see a real push. |
| 8 | Smoke test: `GOOGLE_CLOUD_PROJECT=<project> node apps/alert-service/scripts/mock-event.mjs hotspot --score 0.92 --yes` | Should land on the officer's device; the alert's `notificationsSent` shows `push … sent`. |

Verify the push wiring from Terraform outputs: `terraform output alert_push_audience pubsub_push_service_account` must match `PUBSUB_PUSH_AUDIENCE` / `PUBSUB_PUSH_SA_EMAIL` on the service (`gcloud run services describe alert-service-ncr-dev --region asia-south1 --format='value(spec.template.spec.containers[0].env)'`). The plan tests assert this too.

## 4. The signed-upload flow (end to end)

```bash
S=https://<submission-service-url>/api/v1; T="Bearer <citizen ID token>"
R=$(curl -s -X POST $S/submissions/upload-url -H "authorization: $T" -H 'content-type: application/json' \
      -d '{"kind":"photo","contentType":"image/jpeg"}')
curl -s -X PUT "$(jq -r .uploadUrl <<<"$R")" -H 'Content-Type: image/jpeg' --data-binary @smog.jpg   # EXACT same Content-Type
curl -s -X POST $S/submissions -H "authorization: $T" -H 'content-type: application/json' \
  -d "{\"mediaType\":\"photo\",\"photoStorageUrl\":\"$(jq -r .storageUrl <<<"$R")\",\"geo\":{\"lat\":28.6329,\"lng\":77.2195},\"capturedAt\":\"$(date -u +%FT%TZ)\"}"
```

`storageUrl` is `gs://<bucket>/submissions/<uid>/<date>/photo-<uuid>.jpg`. POST /submissions rejects any URL outside the caller's own prefix.

## 5. What changed and why

**Week 1 bugs found and fixed** (each has a regression test):

1. 429 responses carried `VALIDATION_ERROR`, not `RATE_LIMITED` (every non-5xx status mapped to it).
2. Unknown routes returned Fastify's own 404 shape instead of the `ApiError` envelope.
3. Rate limit keyed per IP — behind Indian mobile-carrier CGNAT that throttles whole towns together. Now per verified uid (runs after auth).
4. Pagination: `nextPageToken` always returned (clients fetched a final empty page); `totalCount` was the page length. Now: token only on a full page, real `count()`, snapshot cursor (no skipped ties).
5. Official-side `GET /submissions` had no composite index — would 400 in the real project. The emulator doesn't enforce indexes, so it never showed.
6. Geocoding: no timeout; only `results[0]`; Delhi districts became e.g. `DL-CENTRAL-DELHI`, matching no provisioned officer.
7. `.dockerignore` lived in the app folder but the build context is the repo root, so it was never applied: local `.env` files were baked into images, and CI copied host `node_modules` over the container's. Now a root `.dockerignore`.

**New / notable behaviour**

- `packages/gcp-clients`: shared jurisdiction resolver (both services must produce identical district codes), signed-URL helper, `getAdminMessaging()`, shared test fake at `@vayusetu/gcp-clients/testing`.
- `alert-service`: severity computed deterministically **before** any briefing (AI_PIPELINES.md Pipeline C rule); briefing behind a `BriefingGenerator` seam validated against Pipeline C's exact `draft_alert_briefing` schema; deterministic alert ids; suppression window; at-least-once dispatch; push endpoints verify Google OIDC + audience + exact SA email; malformed events ACKed, transient failures NACKed → retry → dead-letter.
- Stubbed SMS/WhatsApp deliveries are logged but **never written to `notificationsSent`** — the audit trail an official sees never claims an SMS went out when none did.
- `index.ts` refuses to boot with `AUTH_MODE=mock` or `PUBSUB_PUSH_AUTH=off` in production.

## 6. Contract & schema items — flagged, need owners' sign-off

**API_CONTRACTS.md (I'm steward — merge + changelog + notify E1, E4):** add to §4.2 Submissions:

> **`POST /submissions/upload-url`** — Auth: citizen, field_worker (registered). Request: `{ kind: 'photo' | 'audio'; contentType: string }` (photo: image/jpeg, image/png, image/webp; audio: audio/webm, audio/ogg, audio/mp4, audio/mpeg, audio/wav; parameters such as `;codecs=opus` allowed). Response `200`: `{ uploadUrl: string; storageUrl: string; expiresAt: ISODateString }` — client PUTs the blob to `uploadUrl` with the identical `Content-Type` within 15 min, then passes `storageUrl` (`gs://…`) to `POST /submissions`, which rejects URLs not issued to the caller. Errors: `400`, `401`, `403`, `429`.

Also: `POST /submissions` should list `403` (official callers) and `500` (jurisdiction unresolvable — client retries); `POST /alerts/:id/assign` should list `400` (officer missing or not covering the alert). The endpoint count becomes **24** — Engineer 4's Week 4 regression pass references 23.

**DB_SCHEMA.md (Engineer 4 steward; I co-sign Firestore):**
- `alerts/{alertId}` is Auto-ID in the doc; implemented as deterministic `hotspot_<HotspotCell.id>` / `forecast_<ForecastRun.id>_<stateCode>` so Pub/Sub redelivery can't duplicate alerts or re-page officials.
- The `alerts` index sorts `severity DESC` on a **string** → `watch > warning > info > critical`: critical sorts last. Kept in Terraform, unused; `GET /alerts` sorts by `createdAt`. Fix options: add a numeric `severityRank` field (contract change) or sort client-side.
- Add the 8 merge indexes in `firestore.tf` to the doc's index list.
- `Jurisdiction` codes are typed as LGD codes but every fixture uses short codes (`DL-CENTRAL`); numeric LGD codes appear nowhere. Need one canonical district-code list in `data/seed/`; the resolver's alias table should be generated from it.

**Product decisions to confirm (whole team):** channels by severity (watch=push; warning=+SMS; critical=+WhatsApp) · one forecast alert per corridor state, state-level · 24 h suppression, escalation on higher severity · hotspot thresholds 0.60/0.75/0.90 (placeholders until the model's scores are calibrated).

## 7. Cross-team notes

**Engineer 1**
- `uploadClient.ts`: swap `/mock-storage/sign` for `POST /api/v1/submissions/upload-url` (body `{kind, contentType}`; response shape unchanged + `expiresAt`). PUT must send the **exact** signed `Content-Type`. `storageUrl` is now `gs://…`.
- One `/api/v1` base, two services → Firebase Hosting rewrites (`firebase.json`): `/api/v1/alerts/**` → `alert-service-ncr-dev`; `/api/v1/users/**`, `/api/v1/submissions/**` → `submission-service-ncr-dev` (`"run": {"serviceId": …, "region": "asia-south1"}`). Locally, the equivalent Vite `server.proxy` entries. Same-origin also removes CORS.
- Dashboard FCM: VAPID key + `getToken()` + `PATCH /users/me {fcmTokens}` (server de-dupes, keeps last 10). Push `data` carries `alertId`, `severity`, `link`.
- Server transitions are stricter than the MSW mock (no backwards moves; `dismissed` terminal; `resolved` → `in_progress` only). Every `ALERT_STATUS_SUGGESTED_NEXT` option is accepted — pinned by a test in alert-service; tell me if that map changes.

**Engineer 3**
- `hotspot-service`/`forecast-service`: write the `HotspotCell`/`ForecastRun` doc **before** publishing — alert-service re-reads it and ACKs-and-drops events whose doc is missing.
- Week 3 Pipeline C: implement `BriefingGenerator` (`apps/alert-service/src/domain/briefing.ts`); output is validated against `AlertBriefingSchema` (your function schema, verbatim). Swap point: `src/pipeline/wiring.ts`. Forecasts generate one briefing per corridor state.
- Media URLs are `gs://` — usable directly as Gemini `fileData.fileUri`.
- To get CI: copy `infra/cloudbuild/alert-service.yaml` → `<your-service>.yaml`, change `_SERVICE`, add a line to `local.ci_apps` in `cloudbuild.tf`.

**Engineer 4**
- Contract tests: new upload-url endpoint; deterministic alert ids; `totalCount` is now the real total.
- Composite-index coverage can only be verified against the real project — the emulator never enforces indexes.

## 8. Changelog row for `docs/context/00_PROJECT_INDEX.md`

| Day | File(s) | What changed | By |
|---|---|---|---|
| <day> | 03_API_CONTRACTS.md | + `POST /submissions/upload-url` (24 endpoints); error lists for POST /submissions (+403, +500) and assign (+400) | Engineer 2 |

(Add a 04_DB_SCHEMA.md row once Engineer 4 accepts §6's schema items.)

## 9. Debugging reference

| Symptom | Cause / fix |
|---|---|
| `Cannot sign data without client_email` (local upload-url) | User ADC can't sign. `gcloud auth application-default login --impersonate-service-account=submission-service-ncr-dev@<project>.iam.gserviceaccount.com` (needs Token Creator on that SA), or leave `MEDIA_BUCKET` unset locally. |
| PUT to signed URL → 403 `SignatureDoesNotMatch` | Client sent a different `Content-Type` than it requested the URL for. |
| Real project: `FAILED_PRECONDITION … requires an index` | Index still building (`gcloud firestore indexes composite list`) or missing. The emulator will never show this. |
| Push events vanish, alert-service logs nothing | Push subscriptions enabled before the real image was deployed (§3 step 5), or subscription points at an old URL — `gcloud pubsub subscriptions describe alert-service-hotspot-updated`. |
| alert-service logs `Pub/Sub push token …` + 401 | Audience or SA mismatch — compare `terraform output alert_push_audience` with the service env. |
| Messages piling up in the dead-letter topic | `gcloud pubsub subscriptions pull alert-service.dead-letter-inspect --limit=10`; find the matching `nacking for redelivery` log line. |
| Emulator push never arrives | Re-run `emulator:subscriptions` after each emulator restart, or use `mock-event.mjs … --direct`. |
| Alert created, no push on device | `notificationsSent` says `failed` + no token → officer never registered one; `PUSH_CHANNEL_MODE=stub`; FCM API not enabled; token minted for a different Firebase project. |
| `[STUB sms]` / `[STUB whatsapp]` in logs | Expected — partner gateway not contracted. Nothing was sent, nothing persisted. |
| District admin sees no alerts/submissions | District-code mismatch between the officer's claims and the geocoded code — search logs for `Unmapped district` and add an alias. |
| New claims not applied | Officer must sign out/in (ID tokens cache claims for up to 1 h). |
| type-check: `Cannot find module '@vayusetu/shared-types'` | Its `dist/` is missing. If `pnpm --filter @vayusetu/shared-types build` does nothing, a stale `tsconfig.tsbuildinfo` survived a `dist/` delete -- remove it and rebuild. |
| CI: `ERR_PNPM_OUTDATED_LOCKFILE` | Run `pnpm install`, commit `pnpm-lock.yaml`. |
| CI deploy: `iam.serviceaccounts.actAs` denied | Deployer only acts as runtime SAs of services in `local.ci_apps` with `deploy = true`. |
| `terraform apply` fails on triggers: repository not found | GitHub App not installed/connected (§3 step 3). |
| `terraform test` fails on a regexp validation | Mock provider returned a random string for a computed attribute the module now reads — add a `mock_resource` default in `tests/week2.tftest.hcl`. |
