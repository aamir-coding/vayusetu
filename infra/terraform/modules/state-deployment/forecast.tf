# forecast-service (Feature 3, 72-hour forecast):
#   - Cloud Run service: GET /forecasts/:corridorId/latest|history
#   - Cloud Run Job `forecast-score`: one ForecastRun per corridor every 6 h
#     at :15 -- after ingest-weather-forecast (:10) has landed the horizon's
#     weather covariates.

locals {
  forecast_env = {
    NODE_ENV        = "production"
    AUTH_MODE       = "firebase"
    BQ_DATASET      = google_bigquery_dataset.core.dataset_id
    BQ_LOCATION     = var.bigquery_location
    VERTEX_LOCATION = var.vertex_location
    CORRIDOR_IDS    = join(",", var.corridor_ids)
    FORECASTER      = var.forecaster
    FORECAST_MODEL  = var.forecast_model
  }
}

resource "google_cloud_run_v2_job" "forecast_score" {
  project             = var.project_id
  name                = "forecast-score-${var.environment_name}"
  location            = var.region
  deletion_protection = false
  labels              = var.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.service["forecast-service"].email
      timeout         = "3300s"
      max_retries     = 1
      containers {
        image   = var.ingestion_image # placeholder until CI swaps in the forecast-service image
        command = ["pnpm"]
        args    = ["job:forecast"]
        resources {
          limits = { cpu = "1", memory = "1Gi" }
        }
        env {
          name  = "GOOGLE_CLOUD_PROJECT"
          value = var.project_id
        }
        dynamic "env" {
          for_each = local.forecast_env
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

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_forecast" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.forecast_score.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "forecast_score" {
  count     = var.enable_model_schedules ? 1 : 0
  project   = var.project_id
  region    = var.region
  name      = "forecast-score-${var.environment_name}"
  schedule  = "15 */6 * * *"
  time_zone = "Etc/UTC"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.forecast_score.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_forecast]
}

# GET /forecasts/:corridorId/latest|history and alert-service's forecast history.
resource "google_firestore_index" "forecasts_by_corridor" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "forecasts"
  fields {
    field_path = "corridorId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "forecastRunTimestamp"
    order      = "DESCENDING"
  }
}
