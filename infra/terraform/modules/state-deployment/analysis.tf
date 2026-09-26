# analysis-service (Feature 1): private worker on submission.created.
# Same push design as alert-service (pubsub.tf): OIDC-signed pushes from the
# pubsub_push identity, verified in-app against audience + exact SA email.

locals {
  analysis_push_audience = "vayusetu-analysis-service-${var.environment_name}"
}

resource "google_cloud_run_v2_service_iam_member" "analysis_push_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service["analysis-service"].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

resource "google_pubsub_topic" "analysis_service_dead_letter" {
  project    = var.project_id
  name       = "analysis-service.dead-letter"
  labels     = var.labels
  depends_on = [google_project_service.required]
}

resource "google_pubsub_subscription" "analysis_service_dead_letter_inspect" {
  project                    = var.project_id
  name                       = "analysis-service.dead-letter-inspect"
  topic                      = google_pubsub_topic.analysis_service_dead_letter.id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  labels                     = merge(var.labels, { purpose = "dead-letter" })
}

resource "google_pubsub_topic_iam_member" "analysis_dead_letter_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.analysis_service_dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_service_agent
}

# Leave OFF until analysis-service's real image is deployed: the hello
# placeholder answers 200, which Pub/Sub treats as an ack -> reports lost.
resource "google_pubsub_subscription" "analysis_service_push" {
  count = var.enable_analysis_push_subscription ? 1 : 0

  project = var.project_id
  name    = "analysis-service-submission-created"
  topic   = google_pubsub_topic.events["submission.created"].id
  # Speech-to-Text + context + Gemini (up to 2 calls) + TTS: ~10-25 s typical.
  ack_deadline_seconds = 120

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.service["analysis-service"].uri}/pubsub/submission-created"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.analysis_push_audience
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.analysis_service_dead_letter.id
    max_delivery_attempts = 8
  }

  labels = merge(var.labels, { consumer = "analysis-service" })

  depends_on = [
    google_service_account_iam_member.pubsub_agent_mints_push_tokens,
    google_pubsub_topic_iam_member.analysis_dead_letter_publisher,
  ]
}

resource "google_pubsub_subscription_iam_member" "analysis_dead_letter_source_subscriber" {
  count        = var.enable_analysis_push_subscription ? 1 : 0
  project      = var.project_id
  subscription = google_pubsub_subscription.analysis_service_push[0].name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}

# Pipeline B audio cache + raw-model-response archive: write access on exactly
# these two buckets (project-level objectViewer already covers reading media).
resource "google_storage_bucket_iam_member" "analysis_writes" {
  for_each = {
    advisory_audio  = google_storage_bucket.advisory_audio.name
    model_artifacts = google_storage_bucket.model_artifacts.name
  }
  bucket = each.value
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.service["analysis-service"].email}"
}
