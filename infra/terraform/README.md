# VayuSetu Infra — Terraform

Owner: Engineer 2. This module provisions one full "state deployment" (PRD §3.2 / §6.2) — everything a corridor's backend needs, minus the actual service code, which Cloud Build deploys separately (Week 2).

## Layout

```
infra/terraform/
  modules/state-deployment/   # the reusable module — one per GCP project
  environments/ncr/           # the dev NCR environment, instantiates the module
```

`environments/mumbai-pune/` doesn't exist yet on purpose — that's an explicit Week 3 deliverable (TEAM_ROLES_AND_REPO_MAP.md), proving the module generalizes to a second corridor. Don't create it early; the module is already written to be reusable, there's nothing to "get ready."

## One-time GCP project bootstrap

You need a GCP project and billing before Terraform can do anything.

```bash
gcloud auth login
gcloud projects create vayusetu-ncr-dev --name="VayuSetu NCR Dev"

# List billing accounts, then link one:
gcloud billing accounts list
gcloud billing projects link vayusetu-ncr-dev --billing-account=YOUR_BILLING_ACCOUNT_ID

gcloud config set project vayusetu-ncr-dev
gcloud auth application-default login
```

`gcloud auth application-default login` is what lets Terraform (and, later, the real submission-service running locally against real GCP instead of emulators) authenticate as *you* rather than a service account.

## Apply

```bash
cd infra/terraform/environments/ncr
cp terraform.tfvars.example terraform.tfvars   # edit project_id if you didn't use vayusetu-ncr-dev

terraform init
terraform validate
terraform plan -out=tfplan      # READ this before applying — ~45-55 resources first run
terraform apply tfplan
```

First apply takes 3-6 minutes (mostly API enablement + Cloud Run cold-creates). Expect resource counts in the plan around:
- 18 `google_project_service.required` (API enablement)
- 1 `google_firebase_project`
- 1 `google_firestore_database` + 5 `google_firestore_index`
- 4 `google_pubsub_topic` + 4 `google_pubsub_subscription`
- 2 `google_bigquery_dataset`
- 3 `google_storage_bucket`
- 6 `google_service_account` + ~28 `google_project_iam_member`
- 3 `google_secret_manager_secret`
- 1 `google_artifact_registry_repository`
- 6 `google_cloud_run_v2_service` + 6 `google_cloud_run_v2_service_iam_member`

After it finishes:

```bash
terraform output
```

Copy `service_account_emails` and `cloud_run_urls` somewhere handy — you'll want them for the manual-deploy step below and for debugging IAM issues.

`tfplan`, Terraform state, `terraform.tfvars`, and crash logs are local files and are ignored by Git. Review the plan before applying it; `terraform apply tfplan` creates the development resources and can incur GCP usage charges.

## Populate the real secret values

Terraform only created empty containers (see `secrets.tf` — this is deliberate, state should never hold a plaintext key). Fill them in once you have the actual keys:

```bash
echo -n "AIzaSy..." | gcloud secrets versions add google-maps-api-key --data-file=-
```

The command above creates a secret version but does not automatically connect it to Cloud Run. The real service deployment must explicitly map the secret to `GOOGLE_MAPS_API_KEY`. Revoke any API key that has been pasted into chat, source files, or shell history, then create a replacement with API restrictions.

## Manually deploy submission-service's real image (before Cloud Build exists)

Terraform points every Cloud Run service at a public `hello` placeholder so `apply` succeeds on Day 1. To smoke-test your actual submission-service before Week 2's Cloud Build wiring lands:

```bash
# from the REPO ROOT (Dockerfile needs the whole workspace as build context)
gcloud auth configure-docker asia-south1-docker.pkg.dev

docker build -f apps/submission-service/Dockerfile \
  -t asia-south1-docker.pkg.dev/vayusetu-ncr-dev/vayusetu/submission-service:manual .

docker push asia-south1-docker.pkg.dev/vayusetu-ncr-dev/vayusetu/submission-service:manual

gcloud run deploy submission-service-ncr-dev \
  --image=asia-south1-docker.pkg.dev/vayusetu-ncr-dev/vayusetu/submission-service:manual \
  --region=asia-south1 \
  --project=vayusetu-ncr-dev
```

This updates the *image* only — Terraform's `lifecycle.ignore_changes` means a later `terraform apply` won't fight you over it or revert it.

## Enable Firebase Auth sign-in methods (manual, Console)

`google_firebase_project` turns the project into a Firebase project, but which sign-in methods are active (Anonymous, Phone) is product configuration, not infrastructure — enable both at:
`https://console.firebase.google.com/project/vayusetu-ncr-dev/authentication/providers`
(Anonymous for citizen-pwa's no-login-wall flow; Phone for the verify-your-number upgrade.)

## Debugging Terraform itself

| Symptom | Cause / fix |
|---|---|
| `Error 403: ... API has not been used in project ... before or it is disabled` | An API enabled by `apis.tf` hasn't propagated yet (can take 1-2 min after first enablement). Re-run `terraform apply` — it's idempotent. |
| `Error creating Index: ... index already exists` | Someone (or a previous partial apply) already created that composite index by hand or via a console-click "create index" link. `terraform import` it, or delete the manual one from the Firestore console and re-apply. |
| `googleapi: Error 409: Requested entity already exists` on a bucket | Bucket names are **globally unique across all of GCP**, not just your project. If `${project_id}-citizen-media` collides, change `project_id` (rare, but happens with common names) — don't rename just the bucket, since IAM/code both assume `<project_id>-citizen-media`. |
| `Error: googleapi: Error 400: Precondition check failed` on `google_firebase_project` | The beta provider occasionally lags a GA API change. Fallback: `firebase projects:addfirebase vayusetu-ncr-dev` via the Firebase CLI, then re-run `terraform plan` — it should show the resource as already satisfied. |
| `terraform apply` hangs or a second engineer's apply conflicts with yours | You're both applying against **local state** (see the commented-out `backend "gcs"` block in `providers.tf`). Stand up a state bucket and uncomment it before a second person runs `apply` — this is called out again in `WEEK1_SETUP.md`. |
| `Error: Error creating service account: googleapi: Error 409: already exists` | You ran `apply` from a fresh `terraform init` against a project that already has these service accounts (e.g., partial previous apply, state got deleted). `terraform import google_service_account.service["submission-service"] projects/vayusetu-ncr-dev/serviceAccounts/submission-service-ncr-dev@vayusetu-ncr-dev.iam.gserviceaccount.com` and re-plan. |
| Plan shows unexpected changes to `template[0].containers[0].image` on every run | The `lifecycle.ignore_changes` block in `cloud_run.tf` should prevent this. If you still see it, confirm you're on Terraform >= 1.7 (older versions have bugs with `ignore_changes` on nested list-of-object attributes introduced by `google_cloud_run_v2_service`'s schema). |

## Destroying

```bash
terraform plan -destroy -out=destroy.tfplan
terraform show -no-color destroy.tfplan
terraform apply destroy.tfplan
```
Cloud Run deletion protection may need to be disabled before destroying. Non-production buckets and BigQuery datasets have `force_destroy` / `delete_contents_on_destroy` enabled, so their contents can be deleted. Firestore uses an abandon deletion policy in this module. Do not reuse this pattern unmodified once a `prod` environment exists.
