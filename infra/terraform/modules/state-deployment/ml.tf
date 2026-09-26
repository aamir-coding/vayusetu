# Vertex AI Pipelines retraining (ml/, `python -m vayusetu_ml run|schedule`)
# and the identities Vertex AI uses for batch prediction.

resource "google_service_account" "ml_pipelines" {
  project      = var.project_id
  account_id   = "ml-pipelines-${var.environment_name}"
  display_name = "VayuSetu Vertex AI Pipelines (${var.environment_name})"
  description  = "Runs the retrain DAGs: builds training tables, trains AutoML models, registers versions."
  depends_on   = [google_project_service.required]
}

resource "google_project_iam_member" "ml_pipelines_roles" {
  for_each = toset([
    "roles/aiplatform.user",     # datasets, AutoML training jobs, Model Registry versions + aliases
    "roles/bigquery.dataEditor", # CREATE OR REPLACE training tables, model_evaluations rows
    "roles/bigquery.jobUser",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.ml_pipelines.email}"
}

# Pipeline root (gs://<project>-model-artifacts/pipelines).
resource "google_storage_bucket_iam_member" "ml_pipelines_artifacts" {
  bucket = google_storage_bucket.model_artifacts.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.ml_pipelines.email}"
}

# Vertex AI runs each pipeline step AS this account; the submitter (a human
# or CI) needs actAs on it -- granted to nobody by default here; add the
# person/CI identity that triggers retrains to var.ml_pipeline_submitters.
resource "google_service_account_iam_member" "ml_pipelines_act_as" {
  for_each           = toset(var.ml_pipeline_submitters)
  service_account_id = google_service_account.ml_pipelines.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value
}

# Batch prediction (hotspot-service batch scorer, forecast-service) reads the
# input table and writes predictions AS the Vertex AI service agent.
resource "google_project_service_identity" "aiplatform_agent" {
  provider = google-beta
  project  = var.project_id
  service  = "aiplatform.googleapis.com"
}

resource "google_project_iam_member" "aiplatform_agent_bigquery" {
  for_each = toset(["roles/bigquery.dataEditor", "roles/bigquery.jobUser"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_project_service_identity.aiplatform_agent.email}"
}
