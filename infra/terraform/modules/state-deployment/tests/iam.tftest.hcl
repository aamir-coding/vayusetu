# IAM least-privilege audit (docs/security/IAM_AUDIT.md). Same mocks as phase1.tftest.hcl.
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


run "no_service_holds_a_broad_project_role" {
  command = plan

  assert {
    condition = alltrue([for k, m in google_project_iam_member.service_roles : !contains([
      "roles/owner", "roles/editor", "roles/firebase.admin", "roles/aiplatform.admin",
      "roles/storage.objectAdmin", "roles/storage.objectViewer", "roles/storage.admin",
      "roles/secretmanager.secretAccessor", "roles/pubsub.publisher", "roles/pubsub.subscriber",
      "roles/bigquery.dataEditor", "roles/bigquery.dataViewer", "roles/bigquery.admin",
      "roles/iam.serviceAccountTokenCreator", "roles/iam.serviceAccountUser",
    ], m.role)])
    error_message = "Bucket/secret/topic/dataset/SA-scoped roles belong in iam_scoped.tf, never project-wide."
  }
}

run "token_creator_is_self_only" {
  command = plan

  assert {
    condition     = google_service_account_iam_member.submission_signs_as_itself.role == "roles/iam.serviceAccountTokenCreator"
    error_message = "submission-service signs URLs as itself, via a grant on its own SA."
  }
}

run "each_service_publishes_only_its_own_topic" {
  command = plan

  assert {
    condition     = length(google_pubsub_topic_iam_member.service_publishes) == 4 && google_pubsub_topic_iam_member.service_publishes["hotspot-service"].topic == "hotspot.updated"
    error_message = "One topic per publishing service (API_CONTRACTS.md 4.3)."
  }
  assert {
    condition     = !contains(keys(google_pubsub_topic_iam_member.service_publishes), "alert-service")
    error_message = "alert-service publishes nothing (alert.created is in-process)."
  }
}

run "secrets_are_read_only_by_their_consumers" {
  command = plan

  assert {
    condition     = toset([for g in google_secret_manager_secret_iam_member.service_reads_secret : g.secret_id if g.secret_id == "sms-gateway-credentials"]) == toset(["sms-gateway-credentials"]) && !contains(keys(google_secret_manager_secret_iam_member.service_reads_secret), "submission-service/sms-gateway-credentials")
    error_message = "SMS/WhatsApp gateway credentials are alert-service's alone."
  }
}

run "analysis_service_is_not_publicly_invokable" {
  command = plan

  assert {
    condition     = !contains(keys(google_cloud_run_v2_service_iam_member.public_invoker), "analysis-service")
    error_message = "analysis-service has no public routes; only the Pub/Sub push identity may invoke it."
  }
  assert {
    condition     = contains(keys(google_cloud_run_v2_service_iam_member.public_invoker), "submission-service")
    error_message = "Hosting-routed services stay invokable (Hosting calls Cloud Run unauthenticated)."
  }
}

run "fcm_not_firebase_admin" {
  command = plan

  assert {
    condition     = contains(local.service_accounts["alert-service"].roles, "roles/firebasecloudmessaging.admin")
    error_message = "alert-service needs FCM send, not all of Firebase (Auth user management included)."
  }
}

run "private_push_services_accept_their_push_audience" {
  command = plan

  # A service without public invoke is authenticated by Cloud Run itself,
  # which only accepts tokens for its URL or a listed custom audience. Pub/Sub
  # push tokens carry the custom audience, so it MUST be listed, or every
  # push is rejected with 401 (28 Sep: all reports stuck 'queued').
  assert {
    condition = alltrue([
      for k, svc in google_cloud_run_v2_service.service :
      contains(keys(google_cloud_run_v2_service_iam_member.public_invoker), k) || contains(coalesce(svc.custom_audiences, []), "vayusetu-${k}-${var.environment_name}")
    ])
    error_message = "A private service that receives Pub/Sub pushes must list its push audience in custom_audiences."
  }
}
