# hotspot-service (Feature 2, Hotspot Fusion Engine):
#   - Cloud Run service: GET /hotspots*, analysis.completed push (fast path)
#   - Cloud Run Job `hotspot-score-hourly`: scores every res-8 cell each hour
#     (same image, `pnpm job:hourly`), fired by Cloud Scheduler at :40 --
#     after ingest-weather (:05) and ingest-rollup (:20) have landed the hour.

locals {
  hotspot_push_audience = "vayusetu-hotspot-service-${var.environment_name}"

  hotspot_env = {
    NODE_ENV                    = "production"
    AUTH_MODE                   = "firebase"
    PUBSUB_PUSH_AUTH            = "oidc"
    PUBSUB_PUSH_AUDIENCE        = local.hotspot_push_audience
    PUBSUB_PUSH_SA_EMAIL        = google_service_account.pubsub_push.email
    BQ_DATASET                  = google_bigquery_dataset.core.dataset_id
    BQ_LOCATION                 = var.bigquery_location
    VERTEX_LOCATION             = var.vertex_location
    HOTSPOT_SCORER              = var.hotspot_scorer
    HOTSPOT_ENDPOINT_ID         = var.hotspot_endpoint_id
    HOTSPOT_MODEL               = var.hotspot_model
    HIDDEN_MIN_CONFIDENCE       = "0.6"
    MODEL_HIDDEN_MIN_CONFIDENCE = var.hotspot_model_hidden_min_confidence
    HOTSPOT_MODEL_EVERY_HOURS   = tostring(var.hotspot_model_every_hours)
  }
}

resource "google_cloud_run_v2_job" "hotspot_hourly" {
  project             = var.project_id
  name                = "hotspot-score-hourly-${var.environment_name}"
  location            = var.region
  deletion_protection = false
  labels              = var.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.service["hotspot-service"].email
      timeout         = "3300s" # batch prediction can take most of the hour
      max_retries     = 1
      containers {
        image   = var.ingestion_image # placeholder until CI swaps in the hotspot-service image
        command = ["pnpm"]
        args    = ["job:hourly"]
        resources {
          limits = { cpu = "1", memory = "2Gi" } # ~35k feature rows in memory
        }
        env {
          name  = "GOOGLE_CLOUD_PROJECT"
          value = var.project_id
        }
        dynamic "env" {
          for_each = local.hotspot_env
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

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_hotspot" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.hotspot_hourly.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "hotspot_hourly" {
  count     = var.enable_model_schedules ? 1 : 0
  project   = var.project_id
  region    = var.region
  name      = "hotspot-score-hourly-${var.environment_name}"
  schedule  = "40 * * * *"
  time_zone = "Etc/UTC"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.hotspot_hourly.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_hotspot]
}

# --- analysis.completed -> hotspot-service fast path -------------------------

resource "google_cloud_run_v2_service_iam_member" "hotspot_push_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service["hotspot-service"].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

resource "google_pubsub_topic" "hotspot_service_dead_letter" {
  project    = var.project_id
  name       = "hotspot-service.dead-letter"
  labels     = var.labels
  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic_iam_member" "hotspot_dead_letter_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.hotspot_service_dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_service_agent
}

resource "google_pubsub_subscription" "hotspot_service_push" {
  count = var.enable_hotspot_push_subscription ? 1 : 0

  project              = var.project_id
  name                 = "hotspot-service-analysis-completed"
  topic                = google_pubsub_topic.events["analysis.completed"].id
  ack_deadline_seconds = 60

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.service["hotspot-service"].uri}/pubsub/analysis-completed"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.hotspot_push_audience
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.hotspot_service_dead_letter.id
    max_delivery_attempts = 8
  }

  labels = merge(var.labels, { consumer = "hotspot-service" })
  depends_on = [
    google_service_account_iam_member.pubsub_agent_mints_push_tokens,
    google_pubsub_topic_iam_member.hotspot_dead_letter_publisher,
  ]
}

resource "google_pubsub_subscription_iam_member" "hotspot_dead_letter_source_subscriber" {
  count        = var.enable_hotspot_push_subscription ? 1 : 0
  project      = var.project_id
  subscription = google_pubsub_subscription.hotspot_service_push[0].name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}

# --- Firestore ---------------------------------------------------------------

# Fast path (latest model score for a cell) + alert-service briefing history.
resource "google_firestore_index" "hotspots_by_cell" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "hotspots"
  fields {
    field_path = "h3Index"
    order      = "ASCENDING"
  }
  fields {
    field_path = "timestampHour"
    order      = "DESCENDING"
  }
}

# Heatmap docs are hourly; expire them after 7 days (hotspot_cells in
# BigQuery keeps the full history).
resource "google_firestore_field" "hotspots_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "hotspots"
  field      = "expireAt"
  ttl_config {}
  index_config {}
}
