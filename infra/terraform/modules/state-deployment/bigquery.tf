# Dataset containers only -- table DDL (satellite_features,
# ground_truth_aqi, hotspot_training_dataset, etc.) is Engineer 4's
# stewardship per docs/context/04_DB_SCHEMA.md and lives as versioned SQL
# in data/schemas/, applied separately (e.g. `bq query` or a small
# migration script). Terraform owns the project-level container and
# access boundary; SQL owns the schema.
resource "google_bigquery_dataset" "core" {
  project                    = var.project_id
  dataset_id                 = "core"
  friendly_name              = "VayuSetu Core"
  description                = "Analytical layer: satellite/met/ground-truth features, training datasets. Table DDL owned by Engineer 4 (docs/context/04_DB_SCHEMA.md) -- this module only provisions the dataset container."
  location                   = var.bigquery_location
  delete_contents_on_destroy = var.environment_name != "prod"
  labels                     = var.labels
  depends_on                 = [google_project_service.required]
}

resource "google_bigquery_dataset" "federation_exchange" {
  project                    = var.project_id
  dataset_id                 = "federation_exchange"
  friendly_name              = "VayuSetu Federation Exchange"
  description                = "Shared, k-anonymized cross-state dataset -- kept as a SEPARATE dataset (not just separate tables in `core`) as a hard data-sovereignty boundary, per PRD §3.2 / Feature 4."
  location                   = var.bigquery_location
  delete_contents_on_destroy = var.environment_name != "prod"
  labels                     = var.labels
  depends_on                 = [google_project_service.required]
}
