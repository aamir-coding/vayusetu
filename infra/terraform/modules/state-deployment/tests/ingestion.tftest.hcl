# Ingestion jobs/schedules (ingestion.tf). Same mocks as week2.tftest.hcl.
mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/vayusetu-test/serviceAccounts/mock-sa@vayusetu-test.iam.gserviceaccount.com"
      id    = "projects/vayusetu-test/serviceAccounts/mock-sa@vayusetu-test.iam.gserviceaccount.com"
      email = "mock-sa@vayusetu-test.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_cloud_run_v2_service" {
    defaults = {
      uri = "https://mock-service-abc123-el.a.run.app"
    }
  }
}

mock_provider "google-beta" {
  mock_resource "google_project_service_identity" {
    defaults = {
      email = "service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id       = "vayusetu-test"
  region           = "asia-south1"
  environment_name = "ncr-test"
}


run "ingestion_defaults_are_safe" {
  command = plan

  assert {
    condition     = length(google_cloud_run_v2_job.ingestion) == 10
    error_message = "Every ingestion job should exist (on the placeholder image) from the first apply."
  }
  assert {
    condition     = length(google_cloud_scheduler_job.ingestion) == 0
    error_message = "Schedules must be opt-in until the real image is deployed."
  }
  # Empty secrets must never be referenced (the job would fail to deploy).
  assert {
    condition = alltrue([
      for j in google_cloud_run_v2_job.ingestion : alltrue([
        for e in j.template[0].template[0].containers[0].env : e.value_source == null || length(e.value_source) == 0
      ])
    ])
    error_message = "No job may reference a secret before its *_secret_populated flag is set."
  }
  assert {
    condition     = google_cloud_run_v2_job.ingestion["ingest-cpcb"].template[0].template[0].containers[0].args == tolist(["cpcb"])
    error_message = "ingest-cpcb must run the cpcb subcommand."
  }
}

run "ingestion_schedules_and_secrets_when_enabled" {
  command = plan

  variables {
    enable_ingestion_schedules      = true
    cpcb_api_key_secret_populated   = true
    openaq_api_key_secret_populated = true
    maps_api_key_secret_populated   = true
    corridor_ids                    = ["ncr-airshed"]
  }

  assert {
    condition     = length(google_cloud_scheduler_job.ingestion) == 8
    error_message = "Every job except migrate and the one-off OpenAQ backfill should be scheduled."
  }
  assert {
    condition     = !contains(keys(google_cloud_scheduler_job.ingestion), "ingest-migrate")
    error_message = "migrate runs on deploy, never on a timer."
  }
  assert {
    condition = anytrue([
      for e in google_cloud_run_v2_job.ingestion["ingest-cpcb"].template[0].template[0].containers[0].env :
      e.name == "DATA_GOV_IN_API_KEY"
    ])
    error_message = "ingest-cpcb must receive the data.gov.in key once populated."
  }
  assert {
    condition = anytrue([
      for e in google_cloud_run_v2_job.ingestion["ingest-seed"].template[0].template[0].containers[0].env :
      e.name == "CORRIDOR_IDS" && e.value == "ncr-airshed"
    ])
    error_message = "Jobs must be scoped to this deployment's corridors."
  }
}

run "jobs_without_their_secret_stay_unscheduled" {
  command = plan

  variables {
    enable_ingestion_schedules      = true
    openaq_api_key_secret_populated = true
    maps_api_key_secret_populated   = true
    # cpcb (data.gov.in) key not available yet
  }

  assert {
    condition     = !contains(keys(google_cloud_scheduler_job.ingestion), "ingest-cpcb")
    error_message = "ingest-cpcb must not be scheduled before its key exists (it would fail every hour)."
  }
  assert {
    condition     = contains(keys(google_cloud_scheduler_job.ingestion), "ingest-openaq")
    error_message = "ingest-openaq should be scheduled once its key exists."
  }
}
