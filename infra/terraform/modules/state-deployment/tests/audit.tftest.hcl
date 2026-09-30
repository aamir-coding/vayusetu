# Pre-production readiness audit: H1 App Check, M5 media retention, M8 ack deadline. Same mocks as phase1.tftest.hcl.
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


run "audit_switches_default_off" {
  command = plan

  assert {
    condition     = length(google_recaptcha_enterprise_key.citizen) == 0 && length(google_firebase_app_check_recaptcha_enterprise_config.citizen) == 0
    error_message = "App Check resources are opt-in (enable_app_check)."
  }
  assert {
    condition     = !contains(keys(local.frontend_env["citizen-pwa"]), "VITE_RECAPTCHA_SITE_KEY")
    error_message = "No site key ships until App Check is enabled."
  }
  assert {
    condition     = local.service_env["submission-service"].APP_CHECK == "off"
    error_message = "submission-service must not check tokens by default."
  }
  assert {
    condition     = alltrue([for r in google_storage_bucket.citizen_media.lifecycle_rule : one(r.action).type != "Delete"])
    error_message = "Citizen media is never deleted unless citizen_media_retention_days is set."
  }
}

run "app_check_on_ships_site_key_to_citizen_build_only" {
  command = plan
  variables {
    enable_app_check = true
    app_check_mode   = "monitor"
  }
  assert {
    condition     = length(google_recaptcha_enterprise_key.citizen) == 1
    error_message = "enable_app_check creates the reCAPTCHA Enterprise key."
  }
  assert {
    condition     = contains(one(google_recaptcha_enterprise_key.citizen[0].web_settings).allowed_domains, "vayusetu-test.web.app")
    error_message = "The key must allow the citizen Hosting domain."
  }
  assert {
    condition     = !contains(keys(local.frontend_env["admin-dashboard"]), "VITE_RECAPTCHA_SITE_KEY")
    error_message = "Only the citizen PWA uses App Check."
  }
  assert {
    condition     = local.service_env["submission-service"].APP_CHECK == "monitor"
    error_message = "app_check_mode reaches submission-service."
  }
}

run "retention_adds_a_delete_rule" {
  command = plan
  variables {
    citizen_media_retention_days = 90
  }
  assert {
    condition     = anytrue([for r in google_storage_bucket.citizen_media.lifecycle_rule : one(r.action).type == "Delete" && one(r.condition).age == 90])
    error_message = "citizen_media_retention_days = 90 deletes media older than 90 days."
  }
}

run "retention_rejects_too_short" {
  command = plan
  variables {
    citizen_media_retention_days = 7
  }
  expect_failures = [var.citizen_media_retention_days]
}

run "alert_push_ack_deadline_covers_a_briefing" {
  command = plan
  variables {
    enable_alert_push_subscriptions = true
  }
  assert {
    condition     = alltrue([for s in google_pubsub_subscription.alert_service_push : s.ack_deadline_seconds == 120])
    error_message = "Audit M8: alert-service push needs 120 s (Gemini briefing + geocode + FCM)."
  }
}

run "cors_pinned_to_hosting_origins" {
  command = plan
  assert {
    condition     = local.cors_origin != "*" && strcontains(local.cors_origin, "https://vayusetu-test.web.app") && strcontains(local.cors_origin, "https://vayusetu-test-admin.web.app")
    error_message = "Audit L7: CORS allows exactly the citizen and admin Hosting origins, not '*'."
  }
  assert {
    condition     = !contains(local.cors_services, "analysis-service")
    error_message = "analysis-service is push-only and has no CORS config."
  }
}

run "fallback_routing_is_alerted" {
  command = plan
  assert {
    condition     = strcontains(one(google_monitoring_alert_policy.alert_fallback_routing.conditions).condition_matched_log[0].filter, "Cell centre did not geocode")
    error_message = "Audit L9: the state-fallback log line raises an incident."
  }
}
