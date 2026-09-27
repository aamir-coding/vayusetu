# Monitoring and alerting (monitoring.tf). Same mocks as phase1.tftest.hcl.
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


run "every_service_has_a_5xx_alert_and_policies_link_the_runbook" {
  command = plan

  assert {
    condition     = length(google_monitoring_alert_policy.service_5xx) == length(local.cloud_run_services)
    error_message = "One 5xx policy per Cloud Run service."
  }
  assert {
    condition = alltrue([for p in concat(values(google_monitoring_alert_policy.service_5xx), [google_monitoring_alert_policy.service_429, google_monitoring_alert_policy.job_failed, google_monitoring_alert_policy.uptime]) :
    strcontains(p.documentation[0].content, "RUNBOOK.md")])
    error_message = "Every alert tells the operator which runbook section to open."
  }
}

run "no_emails_means_no_channels_but_policies_still_exist" {
  command = plan

  assert {
    condition     = length(google_monitoring_notification_channel.email) == 0 && length(google_monitoring_alert_policy.service_429.notification_channels) == 0
    error_message = "Without alert_emails, policies exist with no channels (console-only)."
  }
}

run "emails_become_channels" {
  command = plan

  variables {
    alert_emails = ["oncall@example.com"]
  }

  assert {
    condition     = length(google_monitoring_notification_channel.email) == 1 && google_monitoring_notification_channel.email["oncall@example.com"].type == "email"
    error_message = "Each alert email becomes a notification channel."
  }
}

run "freshness_follows_the_schedules" {
  command = plan

  assert {
    condition     = length(google_monitoring_alert_policy.data_freshness) == 0
    error_message = "With schedules off, nothing is expected to run: no staleness alerts."
  }
}

run "freshness_on_when_scheduled" {
  command = plan

  variables {
    enable_ingestion_schedules = true
    enable_model_schedules     = true
  }

  assert {
    condition     = contains(keys(google_monitoring_alert_policy.data_freshness), "hotspot-score-hourly-ncr-test") && google_monitoring_alert_policy.data_freshness["hotspot-score-hourly-ncr-test"].conditions[0].condition_absent[0].duration == "10800s"
    error_message = "The live heatmap's hourly scorer must alert after 3 h without a success."
  }
  assert {
    condition     = length(google_monitoring_alert_policy.data_freshness) == 5
    error_message = "weather, rollup, openaq, hotspot, forecast."
  }
}

run "dead_letters_watched_for_every_push_consumer" {
  command = plan

  assert {
    condition     = toset(keys(google_monitoring_alert_policy.dead_letters)) == toset(["analysis-service", "alert-service", "hotspot-service"])
    error_message = "Every push subscription's dead-letter topic is alerted on."
  }
}

run "budget_is_opt_in" {
  command = plan

  assert {
    condition     = length(google_billing_budget.monthly) == 0
    error_message = "No billing account id -> no budget resource (needs billing-account permission)."
  }
}

run "budget_when_account_given" {
  command = plan

  variables {
    billing_account_id = "000000-000000-000000"
    monthly_budget     = 15000
  }

  assert {
    condition     = google_billing_budget.monthly[0].amount[0].specified_amount[0].units == "15000"
    error_message = "Budget amount comes from monthly_budget."
  }
  assert {
    condition     = length(google_billing_budget.monthly[0].threshold_rules) == 4
    error_message = "50/90/100% actual and 100% forecast."
  }
}
