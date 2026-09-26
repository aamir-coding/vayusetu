# Plan-level tests for the state-deployment module -- no GCP credentials
# needed (mock providers). Runs with Terraform >= 1.7 or OpenTofu >= 1.8:
#   cd infra/terraform/modules/state-deployment
#   terraform init -backend=false && terraform test
#
# These pin the Week 2 behaviours that `validate` can't see, because with
# default variables the gated resources expand to nothing.

# Mocks generate random strings for computed attributes, which fail the
# provider's own format validation where the module feeds one resource's
# computed attribute into another (e.g. a SA's `name` into an IAM binding).
# Give those realistic shapes.
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

run "defaults_are_safe" {
  command = plan

  # Hello-world placeholder would ack (and drop) every push -> off by default.
  assert {
    condition     = length(google_pubsub_subscription.alert_service_push) == 0
    error_message = "Push subscriptions must be opt-in until alert-service's real image is deployed."
  }
  # Needs the manual GitHub App connection first -> off by default.
  assert {
    condition     = length(google_cloudbuild_trigger.pr) == 0 && length(google_cloudbuild_trigger.main) == 0
    error_message = "CI triggers must be opt-in."
  }
  # Cloud Run can't deploy against a secret with no versions -> not wired by default.
  assert {
    condition = alltrue([
      for e in google_cloud_run_v2_service.service["submission-service"].template[0].containers[0].env : e.name != "GOOGLE_MAPS_API_KEY"
    ])
    error_message = "GOOGLE_MAPS_API_KEY must not be wired until maps_api_key_secret_populated = true."
  }
  # The DLQ exists regardless, with a subscription so dead letters aren't discarded.
  assert {
    condition     = google_pubsub_subscription.alert_service_dead_letter_inspect.name == "alert-service.dead-letter-inspect"
    error_message = "Dead-letter topic needs an inspect subscription."
  }
}

run "alert_service_env_matches_push_config" {
  command = plan

  variables {
    enable_alert_push_subscriptions = true
  }

  assert {
    condition     = length(google_pubsub_subscription.alert_service_push) == 2
    error_message = "Expected push subscriptions for hotspot.updated and forecast.updated."
  }
  # The audience alert-service verifies must be the audience Pub/Sub signs for.
  assert {
    condition = contains(
      [for e in google_cloud_run_v2_service.service["alert-service"].template[0].containers[0].env : e.value if e.name == "PUBSUB_PUSH_AUDIENCE"],
      google_pubsub_subscription.alert_service_push["hotspot.updated"].push_config[0].oidc_token[0].audience,
    )
    error_message = "PUBSUB_PUSH_AUDIENCE env must equal the subscription's OIDC audience."
  }
  assert {
    condition = contains(
      [for e in google_cloud_run_v2_service.service["alert-service"].template[0].containers[0].env : e.value if e.name == "PUBSUB_PUSH_AUTH"],
      "oidc",
    )
    error_message = "Deployed alert-service must verify push tokens."
  }
  assert {
    condition     = google_pubsub_subscription.alert_service_push["forecast.updated"].dead_letter_policy[0].max_delivery_attempts == 10
    error_message = "Push subscriptions must dead-letter after bounded retries."
  }
  # Other engineers' services get no Engineer-2 env injected.
  assert {
    condition     = length(google_cloud_run_v2_service.service["hotspot-service"].template[0].containers[0].env) == 1
    error_message = "Only GOOGLE_CLOUD_PROJECT should be set on services Engineer 2 doesn't own."
  }
}

run "maps_secret_wired_when_populated" {
  command = plan

  variables {
    maps_api_key_secret_populated = true
  }

  assert {
    condition = length([
      for e in google_cloud_run_v2_service.service["alert-service"].template[0].containers[0].env : e if e.name == "GOOGLE_MAPS_API_KEY"
    ]) == 1
    error_message = "alert-service needs GOOGLE_MAPS_API_KEY once the secret is populated."
  }
  assert {
    condition = length([
      for e in google_cloud_run_v2_service.service["analysis-service"].template[0].containers[0].env : e if e.name == "GOOGLE_MAPS_API_KEY"
    ]) == 0
    error_message = "Only the geocoding services get the Maps key."
  }
}

run "ci_triggers_path_filtered_and_deploy_gated" {
  command = plan

  variables {
    enable_ci_triggers = true
    github_owner       = "vayusetu"
    github_repo        = "vayusetu"
  }

  assert {
    condition     = length(google_cloudbuild_trigger.pr) == 4 && length(google_cloudbuild_trigger.main) == 4
    error_message = "Expected a PR and a main trigger for each of the 4 apps."
  }
  assert {
    condition     = alltrue([for t in google_cloudbuild_trigger.pr : t.substitutions["_DEPLOY"] == "false"])
    error_message = "PR builds must never deploy."
  }
  assert {
    condition = (
      google_cloudbuild_trigger.main["alert-service"].substitutions["_DEPLOY"] == "true" &&
      google_cloudbuild_trigger.main["citizen-pwa"].substitutions["_DEPLOY"] == "false"
    )
    error_message = "Only backend services deploy from CI in Week 2."
  }
  assert {
    condition = (
      contains(google_cloudbuild_trigger.pr["alert-service"].included_files, "apps/alert-service/**") &&
      contains(google_cloudbuild_trigger.pr["alert-service"].included_files, "packages/gcp-clients/**") &&
      !contains(google_cloudbuild_trigger.pr["alert-service"].included_files, "apps/citizen-pwa/**")
    )
    error_message = "Triggers must be path-filtered to the app and its shared packages."
  }
  # actAs only on the runtime SAs CI deploys -- never project-wide.
  assert {
    condition     = length(google_service_account_iam_member.cloudbuild_act_as_runtime) == 2
    error_message = "Deployer should act as exactly the 2 deployable services' runtime SAs."
  }
}

run "ci_triggers_require_repo_coordinates" {
  command = plan

  variables {
    enable_ci_triggers = true
  }

  expect_failures = [
    google_cloudbuild_trigger.pr,
    google_cloudbuild_trigger.main,
  ]
}
