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
    analysis-service    = { min_instances = 0, max_instances = 10, memory = "512Mi", cpu = "1" }
    hotspot-service     = { min_instances = 0, max_instances = 5, memory = "1Gi", cpu = "1" }
    forecast-service    = { min_instances = 0, max_instances = 5, memory = "1Gi", cpu = "1" }
    alert-service       = { min_instances = 0, max_instances = 10, memory = "512Mi", cpu = "1" }
    federation-service  = { min_instances = 0, max_instances = 3, memory = "512Mi", cpu = "1" }
  }
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
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
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
