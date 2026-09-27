# The National Federation Exchange (PRODUCT_SPEC Feature 4): a project no
# state owns, holding only what states choose to share --
#   - federation_exchange.hotspot_summary  k-anonymized weekly res-6 aggregates
#   - federation_exchange.shared_models    catalog (metrics travel here; Model
#                                          Registry copies drop evaluations)
#   - federation_exchange.model_imports    who imported what (downloadCount)
#   - Vertex AI Model Registry             the shared model artifacts
# Each state's federation-service identity gets write on the dataset and
# model upload/copy here; nothing of any state is reachable from here.

locals {
  apis = [
    "bigquery.googleapis.com",
    "aiplatform.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ]
}

resource "google_project_service" "required" {
  for_each                   = toset(local.apis)
  project                    = var.project_id
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}

# Google creates this lazily otherwise; states grant it cross-project model read.
resource "google_project_service_identity" "vertex_agent" {
  provider   = google-beta
  project    = var.project_id
  service    = "aiplatform.googleapis.com"
  depends_on = [google_project_service.required]
}

resource "google_bigquery_dataset" "exchange" {
  project                    = var.project_id
  dataset_id                 = "federation_exchange"
  friendly_name              = "VayuSetu National Federation Exchange"
  description                = "Shared, k-anonymized aggregates and model catalog. No raw citizen data, ever."
  location                   = var.location
  delete_contents_on_destroy = false
  labels                     = var.labels
  depends_on                 = [google_project_service.required]
}

# DB_SCHEMA.md federation_exchange.hotspot_summary, verbatim.
resource "google_bigquery_table" "hotspot_summary" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.exchange.dataset_id
  table_id            = "hotspot_summary"
  deletion_protection = true
  time_partitioning {
    type  = "DAY"
    field = "week_start_date"
  }
  clustering = ["source_state_code"]
  schema = jsonencode([
    { name = "source_state_code", type = "STRING", mode = "REQUIRED" },
    { name = "h3_index_generalized", type = "STRING", mode = "REQUIRED", description = "Res-6 parent; never the operational res-8 grid" },
    { name = "week_start_date", type = "DATE", mode = "REQUIRED", description = "Monday, IST" },
    { name = "avg_hotspot_confidence", type = "FLOAT64", mode = "NULLABLE" },
    { name = "underlying_report_count_bucket", type = "STRING", mode = "NULLABLE", description = "10-50 | 50-200 | 200+ (never exact)" },
    { name = "model_version", type = "STRING", mode = "REQUIRED" },
    { name = "shared_at", type = "TIMESTAMP", mode = "REQUIRED" },
  ])
}

resource "google_bigquery_table" "shared_models" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.exchange.dataset_id
  table_id            = "shared_models"
  deletion_protection = true
  clustering          = ["model_type", "source_state_code"]
  schema = jsonencode([
    { name = "model_id", type = "STRING", mode = "REQUIRED" },
    { name = "source_state_code", type = "STRING", mode = "REQUIRED" },
    { name = "model_type", type = "STRING", mode = "REQUIRED", description = "hotspot | forecast" },
    { name = "version", type = "STRING", mode = "REQUIRED" },
    { name = "feature_schema_version", type = "STRING", mode = "REQUIRED", description = "hs-v1 / fc-v1; imports must match" },
    { name = "vertex_model_registry_uri", type = "STRING", mode = "REQUIRED" },
    { name = "training_record_count", type = "INT64", mode = "NULLABLE" },
    { name = "training_date_range_start", type = "TIMESTAMP", mode = "NULLABLE" },
    { name = "training_date_range_end", type = "TIMESTAMP", mode = "NULLABLE" },
    { name = "performance_metrics", type = "STRING", mode = "NULLABLE", description = "JSON object of flattened evaluation metrics" },
    { name = "shared_at", type = "TIMESTAMP", mode = "REQUIRED" },
  ])
}

resource "google_bigquery_table" "model_imports" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.exchange.dataset_id
  table_id            = "model_imports"
  deletion_protection = true
  schema = jsonencode([
    { name = "model_id", type = "STRING", mode = "REQUIRED" },
    { name = "importing_state_code", type = "STRING", mode = "REQUIRED" },
    { name = "imported_at", type = "TIMESTAMP", mode = "REQUIRED" },
  ])
}

# ---- member states
# Row ownership (a state only replaces its own summary rows) is enforced by
# federation-service's MERGE scoping; BigQuery IAM has no row-level WRITE
# policy. Everything a state can write here is k-anonymized before it leaves.
resource "google_bigquery_dataset_iam_member" "state_writes" {
  for_each   = var.member_states
  project    = var.project_id
  dataset_id = google_bigquery_dataset.exchange.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${each.value.service_account}"
}

# copyModel INTO this registry (publish) and read from it (import).
resource "google_project_iam_member" "state_registry_user" {
  for_each = var.member_states
  project  = var.project_id
  role     = "roles/aiplatform.user"
  member   = "serviceAccount:${each.value.service_account}"
}

# Import direction: the importing state's Vertex agent reads models here.
resource "google_project_iam_member" "state_vertex_agent_reads_models" {
  for_each = var.member_states
  project  = var.project_id
  role     = "roles/aiplatform.viewer"
  member   = "serviceAccount:service-${each.value.project_number}@gcp-sa-aiplatform.iam.gserviceaccount.com"
}
