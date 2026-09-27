# federation-service (Feature 4, "The Bridge"):
#   - Cloud Run service: GET /federation/models, POST .../import,
#     GET /federation/exchange/hotspot-summary
#   - Cloud Run Job `federation-sync`: nightly k-anonymized summary export,
#     model publish to the National Exchange, catalog pull.
# The Exchange itself is a SEPARATE project (infra/terraform/modules/exchange);
# with exchange_project_id unset the service still deploys (its endpoints
# answer from the Firestore mirror) but the sync job is not scheduled.

locals {
  federation_env = {
    NODE_ENV                = "production"
    AUTH_MODE               = "firebase"
    FEDERATION_STATE_CODE   = var.federation_state_code
    FEDERATION_OWNED_STATES = join(",", var.federation_owned_states)
    EXCHANGE_PROJECT_ID     = coalesce(var.exchange_project_id, "unset")
    EXCHANGE_DATASET        = "federation_exchange"
    BIGQUERY_LOCATION       = var.bigquery_location
    VERTEX_LOCATION         = var.vertex_location
  }
  federation_sync_enabled = var.enable_federation_sync && var.exchange_project_id != ""
}

resource "google_cloud_run_v2_job" "federation_sync" {
  project             = var.project_id
  name                = "federation-sync-${var.environment_name}"
  location            = var.region
  deletion_protection = false
  labels              = var.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.service["federation-service"].email
      timeout         = "1800s"
      max_retries     = 2 # every step is idempotent (see nightlySync.ts)
      containers {
        image   = var.ingestion_image # placeholder until CI swaps in the federation-service image
        command = ["pnpm"]
        args    = ["sync"]
        resources {
          limits = { cpu = "1", memory = "1Gi" }
        }
        env {
          name  = "GOOGLE_CLOUD_PROJECT"
          value = var.project_id
        }
        dynamic "env" {
          for_each = local.federation_env
          content {
            name  = env.key
            value = env.value
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }
  depends_on = [google_project_iam_member.service_roles]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_federation" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.federation_sync.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# 02:30 IST daily. Only complete IST weeks are published, so daily runs
# republish the same week idempotently and pick up newly promoted models.
resource "google_cloud_scheduler_job" "federation_sync" {
  count     = local.federation_sync_enabled ? 1 : 0
  project   = var.project_id
  region    = var.region
  name      = "federation-sync-${var.environment_name}"
  schedule  = "30 2 * * *"
  time_zone = "Asia/Kolkata"

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.federation_sync.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_federation]
}

# Cross-project Model Registry copy: the DESTINATION project's Vertex AI
# service agent needs to read the SOURCE model. This grants the Exchange's
# agent read on our registry (publish direction); the Exchange module grants
# our agent read on its registry (import direction).
resource "google_project_iam_member" "exchange_vertex_agent_reads_models" {
  count   = var.exchange_project_number != "" ? 1 : 0
  project = var.project_id
  role    = "roles/aiplatform.viewer"
  member  = "serviceAccount:service-${var.exchange_project_number}@gcp-sa-aiplatform.iam.gserviceaccount.com"
}
