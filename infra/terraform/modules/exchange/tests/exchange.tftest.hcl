mock_provider "google" {}
mock_provider "google-beta" {}

variables {
  project_id = "vayusetu-exchange-test"
  member_states = {
    DL = { service_account = "federation-service-ncr-dev@vayusetu-ncr-dev.iam.gserviceaccount.com", project_number = "111" }
    MH = { service_account = "federation-service-mh-dev@vayusetu-mh-dev.iam.gserviceaccount.com", project_number = "222" }
  }
}

run "tables_match_what_federation_service_writes" {
  command = plan

  assert {
    condition     = toset([for c in jsondecode(google_bigquery_table.hotspot_summary.schema) : c.name]) == toset(["source_state_code", "h3_index_generalized", "week_start_date", "avg_hotspot_confidence", "underlying_report_count_bucket", "model_version", "shared_at"])
    error_message = "hotspot_summary must be exactly the DB_SCHEMA.md columns -- nothing finer-grained may exist here."
  }
  assert {
    condition     = google_bigquery_table.hotspot_summary.time_partitioning[0].field == "week_start_date"
    error_message = "Partitioned by week."
  }
  assert {
    condition     = contains([for c in jsondecode(google_bigquery_table.shared_models.schema) : c.name], "feature_schema_version")
    error_message = "Imports are schema-checked (409), so the catalog must carry the feature schema."
  }
}

run "every_member_state_gets_exactly_its_grants" {
  command = plan

  assert {
    condition     = length(google_bigquery_dataset_iam_member.state_writes) == 2 && length(google_project_iam_member.state_registry_user) == 2
    error_message = "One dataset write + one registry grant per member state."
  }
  assert {
    condition     = google_project_iam_member.state_vertex_agent_reads_models["MH"].member == "serviceAccount:service-222@gcp-sa-aiplatform.iam.gserviceaccount.com"
    error_message = "The importing state Vertex agent reads the exchange registry."
  }
  assert {
    condition     = google_bigquery_dataset_iam_member.state_writes["DL"].role == "roles/bigquery.dataEditor"
    error_message = "Dataset-scoped write, not project-wide."
  }
}

run "rejects_malformed_members" {
  command = plan

  variables {
    member_states = { delhi = { service_account = "x", project_number = "1" } }
  }
  expect_failures = [var.member_states]
}
