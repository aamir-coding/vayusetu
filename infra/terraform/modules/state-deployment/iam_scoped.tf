# Resource-scoped grants for the service accounts in iam.tf (IAM audit,
# docs/security/IAM_AUDIT.md). Each replaces a project-wide role that let a
# service touch EVERY bucket / secret / topic / dataset in the project.

locals {
  sa = { for k, v in google_service_account.service : k => "serviceAccount:${v.email}" }

  # Which topic each service publishes (API_CONTRACTS.md 4.3). Push delivery
  # needs no subscriber role on the receiving service, so none is granted.
  topic_publishers = {
    submission-service = "submission.created" # also republished by /clarify
    analysis-service   = "analysis.completed"
    hotspot-service    = "hotspot.updated"
    forecast-service   = "forecast.updated"
  }

  secret_readers = {
    "submission-service/google-maps-api-key"     = { svc = "submission-service", secret = "google-maps-api-key" }
    "analysis-service/google-maps-api-key"       = { svc = "analysis-service", secret = "google-maps-api-key" }
    "alert-service/google-maps-api-key"          = { svc = "alert-service", secret = "google-maps-api-key" }
    "alert-service/sms-gateway-credentials"      = { svc = "alert-service", secret = "sms-gateway-credentials" }
    "alert-service/whatsapp-gateway-credentials" = { svc = "alert-service", secret = "whatsapp-gateway-credentials" }
  }

  bucket_grants = {
    # signed upload URLs are exercised AS submission-service: write media only
    "submission-service/citizen-media" = { svc = "submission-service", bucket = google_storage_bucket.citizen_media.name, role = "roles/storage.objectAdmin" }
    # signed read URLs for advisory audio (GET /analysis) are authorised AS the signer
    "submission-service/advisory-audio" = { svc = "submission-service", bucket = google_storage_bucket.advisory_audio.name, role = "roles/storage.objectViewer" }
    # the report photo + voice note (writes to its own two buckets: analysis.tf)
    "analysis-service/citizen-media" = { svc = "analysis-service", bucket = google_storage_bucket.citizen_media.name, role = "roles/storage.objectViewer" }
  }

  core_dataset_grants = {
    "analysis-service"   = "roles/bigquery.dataViewer" # context query
    "federation-service" = "roles/bigquery.dataViewer" # core.hotspot_cells weekly aggregate
    "hotspot-service"    = "roles/bigquery.dataEditor" # hotspot_cells, staging loads, batch-prediction tables
    "forecast-service"   = "roles/bigquery.dataEditor" # forecast_runs, batch-prediction tables
  }
}

resource "google_pubsub_topic_iam_member" "service_publishes" {
  for_each = local.topic_publishers
  project  = var.project_id
  topic    = google_pubsub_topic.events[each.value].name
  role     = "roles/pubsub.publisher"
  member   = local.sa[each.key]
}

resource "google_secret_manager_secret_iam_member" "service_reads_secret" {
  for_each  = local.secret_readers
  project   = var.project_id
  secret_id = google_secret_manager_secret.secrets[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.sa[each.value.svc]
}

resource "google_storage_bucket_iam_member" "service_bucket" {
  for_each = local.bucket_grants
  bucket   = each.value.bucket
  role     = each.value.role
  member   = local.sa[each.value.svc]
}

resource "google_bigquery_dataset_iam_member" "service_core" {
  for_each   = local.core_dataset_grants
  project    = var.project_id
  dataset_id = google_bigquery_dataset.core.dataset_id
  role       = each.value
  member     = local.sa[each.key]
}

# V4 signed URLs from Cloud Run have no private key: the SDK calls IAM
# Credentials signBlob AS the runtime SA. Token Creator on ITSELF only -- the
# old project-level grant let submission-service impersonate every service
# account in the project (including the Cloud Build deployer).
resource "google_service_account_iam_member" "submission_signs_as_itself" {
  service_account_id = google_service_account.service["submission-service"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.sa["submission-service"]
}
