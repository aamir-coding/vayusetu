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
  project_id              = "vayusetu-test"
  region                  = "asia-south1"
  environment_name        = "ncr-test"
  federation_state_code   = "DL"
  federation_owned_states = ["DL", "HR", "UP", "RJ"]
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

run "hotspot_defaults_are_safe" {
  command = plan

  assert {
    condition     = length(google_pubsub_subscription.hotspot_service_push) == 0 && length(google_cloud_scheduler_job.hotspot_hourly) == 0
    error_message = "hotspot push + hourly schedule must be opt-in until the image is deployed."
  }
  assert {
    condition     = google_cloud_run_v2_job.hotspot_hourly.template[0].template[0].containers[0].args == tolist(["job:hourly"])
    error_message = "The hourly job runs the job:hourly script from the service image."
  }
  assert {
    condition = anytrue([
      for e in google_cloud_run_v2_service.service["hotspot-service"].template[0].containers[0].env :
      e.name == "HOTSPOT_SCORER" && e.value == "heuristic"
    ])
    error_message = "Scorer defaults to the heuristic bootstrap until a model is registered."
  }
}

run "hotspot_push_and_schedule_when_enabled" {
  command = plan

  variables {
    enable_hotspot_push_subscription = true
    enable_model_schedules           = true
  }

  assert {
    condition     = google_pubsub_subscription.hotspot_service_push[0].push_config[0].oidc_token[0].audience == "vayusetu-hotspot-service-ncr-test"
    error_message = "Push audience must match what hotspot-service verifies."
  }
  assert {
    condition     = google_cloud_scheduler_job.hotspot_hourly[0].schedule == "40 * * * *"
    error_message = "Hourly scoring runs at :40, after weather (:05) and the citizen rollup (:20)."
  }
}

run "forecast_job_defaults" {
  command = plan

  assert {
    condition     = length(google_cloud_scheduler_job.forecast_score) == 0
    error_message = "Forecast schedule must be opt-in."
  }
  assert {
    condition     = google_cloud_run_v2_job.forecast_score.template[0].template[0].containers[0].args == tolist(["job:forecast"])
    error_message = "The forecast job runs the job:forecast script from the service image."
  }
  assert {
    condition     = length(google_project_iam_member.ml_pipelines_roles) == 3
    error_message = "ml-pipelines SA: aiplatform.user + BigQuery dataEditor/jobUser only."
  }
}

run "forecast_schedule_when_enabled" {
  command = plan

  variables {
    enable_model_schedules = true
  }

  assert {
    condition     = google_cloud_scheduler_job.forecast_score[0].schedule == "15 */6 * * *"
    error_message = "Forecasts run every 6 h at :15, after the Weather API forecast (:10)."
  }
}

run "gemini_can_read_citizen_photos" {
  command = plan

  assert {
    condition     = google_storage_bucket_iam_member.aiplatform_agent_reads_media.role == "roles/storage.objectViewer"
    error_message = "Vertex AI's service agent needs read-only access to citizen media for Pipeline A (gs:// fileData)."
  }
}

run "firestore_rules_are_opt_in" {
  command = plan

  assert {
    condition     = length(google_firebaserules_release.firestore) == 0
    error_message = "Releasing Firestore rules changes client access: opt-in only."
  }
}

run "firestore_rules_release_the_tested_file" {
  command = plan

  variables {
    deploy_firestore_rules = true
  }

  assert {
    condition     = strcontains(google_firebaserules_ruleset.firestore[0].source[0].files[0].content, "function covers(j)")
    error_message = "The released ruleset must be packages/firestore-rules/firestore.rules (the emulator-tested file)."
  }
  assert {
    condition     = google_firebaserules_release.firestore[0].name == "cloud.firestore"
    error_message = "Firestore rules are released under the cloud.firestore release name."
  }
}

run "firebase_frontends_are_managed" {
  command = plan

  assert {
    condition     = length(google_firebase_web_app.frontend) == 2 && contains(keys(google_firebase_web_app.frontend), "admin")
    error_message = "Citizen and admin web apps are Terraform-managed so Mumbai-Pune gets them for free."
  }
  assert {
    condition     = google_firebase_hosting_site.admin.site_id == "${var.project_id}-admin"
    error_message = "The admin dashboard deploys to its own Hosting site."
  }
}

run "maps_key_is_locked_to_maps_and_our_origins" {
  command = plan

  assert {
    condition     = one(google_apikeys_key.maps_browser.restrictions[0].api_targets).service == "maps-backend.googleapis.com"
    error_message = "The browser key may call the Maps JavaScript API only."
  }
  assert {
    condition = alltrue([for r in google_apikeys_key.maps_browser.restrictions[0].browser_key_restrictions[0].allowed_referrers :
    startswith(r, "https://${var.project_id}") || startswith(r, "http://localhost:")])
    error_message = "Referrers must be this project's Hosting sites or local dev only."
  }
}

run "federation_sync_needs_an_exchange" {
  command = plan

  variables {
    enable_federation_sync = true
  }

  assert {
    condition     = length(google_cloud_scheduler_job.federation_sync) == 0
    error_message = "No exchange_project_id -> nothing to sync to; the schedule must stay off."
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_job.federation_sync.template[0].template[0].containers[0].env : e.name], "FEDERATION_OWNED_STATES")
    error_message = "The sync job carries the federation env."
  }
  assert {
    condition     = contains(local.service_accounts["federation-service"].roles, "roles/datastore.user")
    error_message = "federation-service reads submissions and writes the federationExchange mirror in Firestore."
  }
}

run "federation_sync_scheduled_with_exchange" {
  command = plan

  variables {
    enable_federation_sync  = true
    exchange_project_id     = "vayusetu-exchange-test"
    exchange_project_number = "123456789"
  }

  assert {
    condition     = google_cloud_scheduler_job.federation_sync[0].time_zone == "Asia/Kolkata"
    error_message = "Sync runs nightly in IST (weeks are IST weeks)."
  }
  assert {
    condition     = google_project_iam_member.exchange_vertex_agent_reads_models[0].member == "serviceAccount:service-123456789@gcp-sa-aiplatform.iam.gserviceaccount.com"
    error_message = "The Exchange's Vertex agent must be able to read our models to copy them."
  }
}
