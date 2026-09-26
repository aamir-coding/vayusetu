# Every backend service gets a real Cloud Run resource in Week 1, even
# though only submission-service has real application code behind it --
# TEAM_ROLES_AND_REPO_MAP.md's Week-1 cross-team "done" criterion is
# explicitly "every service skeleton deployed to Cloud Run (even where
# still returning mock data)". `image` below is a public placeholder;
# `lifecycle.ignore_changes` means Cloud Build (Week 2, see
# TEAM_ROLES_AND_REPO_MAP.md) can push and deploy each service's real
# image afterward without a later `terraform apply` reverting it back to
# hello-world.
#
# SECURITY NOTE (intentional Week 1 scope, not an oversight): every
# service is made publicly invokable below so the team can hit them
# immediately without wiring up Pub/Sub push-auth or a load balancer
# first. TEAM_ROLES_AND_REPO_MAP.md's Week 4 already scopes a "Firestore
# security-rules audit and IAM least-privilege audit" -- tightening which
# services actually need public ingress (submission-service: yes: alert
# webhooks: yes; hotspot/forecast/federation: arguably no, Pub/Sub- and
# Scheduler-triggered only) belongs in that pass, not bolted on ad hoc now.
locals {
  cloud_run_services = {
    submission-service = { min_instances = 0, max_instances = 10, memory = "512Mi", cpu = "1" }
    analysis-service   = { min_instances = 0, max_instances = 10, memory = "512Mi", cpu = "1" }
    hotspot-service    = { min_instances = 0, max_instances = 5, memory = "1Gi", cpu = "1" }
    forecast-service   = { min_instances = 0, max_instances = 5, memory = "1Gi", cpu = "1" }
    alert-service      = { min_instances = 0, max_instances = 10, memory = "512Mi", cpu = "1" }
    federation-service = { min_instances = 0, max_instances = 3, memory = "512Mi", cpu = "1" }
  }

  # Week 2: runtime config for the services Engineer 2 owns. Terraform owns
  # env; Cloud Build only swaps the image (`gcloud run deploy --image`
  # keeps env), so config and code deploys never fight. Other engineers'
  # services get `{}` until they add their own entries here.
  service_env = {
    submission-service = {
      NODE_ENV              = "production"
      AUTH_MODE             = "firebase"
      MEDIA_BUCKET          = google_storage_bucket.citizen_media.name
      DEFAULT_STATE_CODE    = var.default_state_code
      DEFAULT_DISTRICT_CODE = var.default_district_code
    }
    alert-service = {
      NODE_ENV              = "production"
      AUTH_MODE             = "firebase"
      PUBSUB_PUSH_AUTH      = "oidc"
      PUBSUB_PUSH_AUDIENCE  = local.alert_push_audience
      PUBSUB_PUSH_SA_EMAIL  = google_service_account.pubsub_push.email
      PUSH_CHANNEL_MODE     = "live"
      SMS_CHANNEL_MODE      = "stub" # partner gateway not contracted yet (Week 2 scope)
      WHATSAPP_CHANNEL_MODE = "stub"
      DASHBOARD_BASE_URL    = coalesce(var.dashboard_base_url, "https://${var.project_id}.web.app")
      DEFAULT_STATE_CODE    = var.default_state_code
      DEFAULT_DISTRICT_CODE = var.default_district_code
    }
  }

  # Services that reverse-geocode (both call the shared resolver in
  # packages/gcp-clients/src/geocoding.ts).
  maps_key_services = ["submission-service", "alert-service"]
}

resource "google_cloud_run_v2_service" "service" {
  for_each = local.cloud_run_services
  project  = var.project_id
  name     = "${each.key}-${var.environment_name}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.service[each.key].email

    scaling {
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      resources {
        limits = {
          cpu    = each.value.cpu
          memory = each.value.memory
        }
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      dynamic "env" {
        for_each = lookup(local.service_env, each.key, {})
        content {
          name  = env.key
          value = env.value
        }
      }

      # Only once the secret has a version -- see var.maps_api_key_secret_populated.
      dynamic "env" {
        for_each = var.maps_api_key_secret_populated && contains(local.maps_key_services, each.key) ? [1] : []
        content {
          name = "GOOGLE_MAPS_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["google-maps-api-key"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      # Service-level `scaling` is server-defaulted by the API; provider 6.x
      # reports it as a perpetual diff that would hide real drift.
      scaling,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  for_each = local.cloud_run_services
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
