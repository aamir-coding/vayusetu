# Phase 1 AI layer: analysis-service push wiring + Gemini config. Same mocks as week2.tftest.hcl.
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


run "analysis_push_is_opt_in" {
  command = plan

  assert {
    condition     = length(google_pubsub_subscription.analysis_service_push) == 0
    error_message = "The hello placeholder would ack and drop every report: push must be opt-in."
  }
  assert {
    condition = anytrue([
      for e in google_cloud_run_v2_service.service["alert-service"].template[0].containers[0].env :
      e.name == "BRIEFING_GENERATOR" && e.value == "gemini"
    ])
    error_message = "alert-service should brief with Gemini by default (template fallback is in-app)."
  }
}

run "analysis_push_matches_app_config" {
  command = plan

  variables {
    enable_analysis_push_subscription = true
  }

  assert {
    condition     = google_pubsub_subscription.analysis_service_push[0].push_config[0].oidc_token[0].audience == "vayusetu-analysis-service-ncr-test"
    error_message = "Push audience must be the per-environment analysis audience."
  }
  assert {
    condition = anytrue([
      for e in google_cloud_run_v2_service.service["analysis-service"].template[0].containers[0].env :
      e.name == "PUBSUB_PUSH_AUDIENCE" && e.value == "vayusetu-analysis-service-ncr-test"
    ])
    error_message = "The audience analysis-service verifies must equal the one Pub/Sub signs."
  }
  assert {
    condition     = google_pubsub_subscription.analysis_service_push[0].ack_deadline_seconds >= 120
    error_message = "STT + context + Gemini + TTS needs >= 120 s before Pub/Sub redelivers."
  }
  assert {
    condition     = google_pubsub_subscription.analysis_service_push[0].dead_letter_policy[0].max_delivery_attempts == 8
    error_message = "Poison reports must dead-letter instead of retrying forever."
  }
}
