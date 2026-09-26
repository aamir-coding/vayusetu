# Ingestion: one image (apps/ingestion-jobs), one Cloud Run Job per data
# feed, each fired by Cloud Scheduler. Jobs, not Cloud Functions: they are
# finite batch work, need up to an hour (Earth Engine exports), and sharing
# one image keeps the seed data/H3 constants in exactly one place.
#
# Rollout (see docs/EXECUTION_PLAN.md):
#   1. apply (jobs created on the placeholder image, schedules OFF)
#   2. build + push the ingestion-jobs image; CI or
#      `gcloud run jobs update <job> --image=<img>` for each job
#   3. add secret values; set cpcb_api_key_secret_populated = true
#   4. run ingest-migrate, ingest-cpcb, ingest-seed once by hand
#   5. enable_ingestion_schedules = true

locals {
  ingestion_env = {
    GOOGLE_CLOUD_PROJECT = var.project_id
    BQ_DATASET           = google_bigquery_dataset.core.dataset_id
    BQ_LOCATION          = var.bigquery_location
    REFERENCE_BUCKET     = google_storage_bucket.reference.name
    CORRIDOR_IDS         = join(",", var.corridor_ids)
  }

  # secrets: env var name -> Secret Manager secret id
  ingestion_jobs = {
    ingest-migrate          = { args = ["migrate"], schedule = null, timeout = "600s", secrets = {} }
    ingest-cpcb             = { args = ["cpcb"], schedule = "15 * * * *", timeout = "900s", secrets = { DATA_GOV_IN_API_KEY = "cpcb-api-key" } }
    ingest-seed             = { args = ["seed"], schedule = "30 2 * * *", timeout = "1800s", secrets = {} }
    ingest-air-quality      = { args = ["air-quality", "--hours", "26"], schedule = "0 3 * * *", timeout = "3600s", secrets = { GOOGLE_MAPS_API_KEY = "google-maps-api-key" } }
    ingest-weather          = { args = ["weather", "--mode", "observed"], schedule = "5 * * * *", timeout = "900s", secrets = { GOOGLE_MAPS_API_KEY = "google-maps-api-key" } }
    ingest-weather-forecast = { args = ["weather", "--mode", "forecast"], schedule = "10 */6 * * *", timeout = "900s", secrets = { GOOGLE_MAPS_API_KEY = "google-maps-api-key" } }
    ingest-earth-engine     = { args = ["earth-engine"], schedule = "0 4 * * *", timeout = "3600s", secrets = {} }
    ingest-rollup           = { args = ["rollup"], schedule = "20 * * * *", timeout = "900s", secrets = {} }
  }

  # Secrets whose version must exist before a job may reference them.
  ingestion_secret_ready = {
    "cpcb-api-key"        = var.cpcb_api_key_secret_populated
    "google-maps-api-key" = var.maps_api_key_secret_populated
  }
}

resource "google_storage_bucket" "reference" {
  project                     = var.project_id
  name                        = "${var.project_id}-reference"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.environment_name != "prod"
  labels                      = var.labels
  depends_on                  = [google_project_service.required]
}

resource "google_service_account" "ingestion" {
  project      = var.project_id
  account_id   = "ingestion-jobs-${var.environment_name}"
  display_name = "VayuSetu ingestion jobs (${var.environment_name})"
  depends_on   = [google_project_service.required]
}

resource "google_project_iam_member" "ingestion_roles" {
  for_each = toset([
    "roles/bigquery.dataEditor",
    "roles/bigquery.jobUser",
    "roles/datastore.user",                    # corridors, monitoringStations; reads submissions/analysisResults
    "roles/earthengine.writer",                # EE computations + export tasks
    "roles/serviceusage.serviceUsageConsumer", # EE bills requests to this project
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.ingestion.email}"
}

resource "google_storage_bucket_iam_member" "ingestion_reference" {
  bucket = google_storage_bucket.reference.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.ingestion.email}"
}

resource "google_secret_manager_secret_iam_member" "ingestion_secrets" {
  for_each  = toset(["cpcb-api-key", "google-maps-api-key"])
  project   = var.project_id
  secret_id = google_secret_manager_secret.secrets[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingestion.email}"
}

resource "google_cloud_run_v2_job" "ingestion" {
  for_each            = local.ingestion_jobs
  project             = var.project_id
  name                = "${each.key}-${var.environment_name}"
  location            = var.region
  deletion_protection = false
  labels              = var.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.ingestion.email
      timeout         = each.value.timeout
      max_retries     = 1
      containers {
        image = var.ingestion_image
        args  = each.value.args
        resources {
          limits = { cpu = "1", memory = "2Gi" }
        }
        dynamic "env" {
          for_each = local.ingestion_env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = { for k, v in each.value.secrets : k => v if local.ingestion_secret_ready[v] }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.secrets[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    # CI swaps the image (`gcloud run jobs update --image`); Terraform owns the rest.
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_project_iam_member.ingestion_roles, google_secret_manager_secret_iam_member.ingestion_secrets]
}

resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "scheduler-${var.environment_name}"
  display_name = "VayuSetu Cloud Scheduler invoker (${var.environment_name})"
  depends_on   = [google_project_service.required]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_ingestion" {
  for_each = { for k, v in local.ingestion_jobs : k => v if v.schedule != null }
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.ingestion[each.key].name
  role     = "roles/run.invoker" # includes run.jobs.run
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "ingestion" {
  for_each  = { for k, v in local.ingestion_jobs : k => v if v.schedule != null && var.enable_ingestion_schedules }
  project   = var.project_id
  region    = var.region
  name      = "${each.key}-${var.environment_name}"
  schedule  = each.value.schedule
  time_zone = "Etc/UTC"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.ingestion[each.key].name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_ingestion]
}

# CI (infra/cloudbuild/ingestion-jobs.yaml) updates the jobs' image, which
# requires acting as their runtime SA -- this SA only.
resource "google_service_account_iam_member" "cloudbuild_act_as_ingestion" {
  service_account_id = google_service_account.ingestion.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.cloudbuild_deployer.email}"
}

resource "google_cloudbuild_trigger" "ingestion_main" {
  count = var.enable_ci_triggers ? 1 : 0

  project     = var.project_id
  location    = "global"
  name        = "ingestion-jobs-main-${var.environment_name}"
  description = "Test, build and deploy ingestion jobs on push to ${var.ci_branch_regex}"

  github {
    owner = var.github_owner
    name  = var.github_repo
    push {
      branch = var.ci_branch_regex
    }
  }

  filename       = "infra/cloudbuild/ingestion-jobs.yaml"
  included_files = ["apps/ingestion-jobs/**", "data/seed/**", "data/schemas/**", "infra/cloudbuild/ingestion-jobs.yaml"]

  substitutions = {
    _DEPLOY = "true"
    _ENV    = var.environment_name
    _REGION = var.region
  }

  service_account = google_service_account.cloudbuild_deployer.id
  depends_on      = [google_project_iam_member.cloudbuild_deployer]
}
