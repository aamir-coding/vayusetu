# One service account per Cloud Run service. PROJECT-level roles here are
# only those with no narrower resource to bind to (Firestore, BigQuery job
# execution, Vertex AI, Speech, FCM). Everything that CAN be scoped -- buckets,
# secrets, topics, the core dataset, the signing identity -- is granted on
# that resource in iam_scoped.tf. Audit + rationale: docs/security/IAM_AUDIT.md.
locals {
  service_accounts = {
    submission-service = {
      roles = [
        "roles/datastore.user", # Firestore read/write
      ]
    }
    analysis-service = {
      roles = [
        "roles/datastore.user",
        "roles/aiplatform.user",                   # Gemini 3.7 Flash (Pipeline A)
        "roles/speech.client",                     # Speech-to-Text v2 (voice notes)
        "roles/serviceusage.serviceUsageConsumer", # Text-to-Speech has no finer-grained role
        "roles/bigquery.jobUser",                  # context query (h3_cells, ground truth, satellite)
      ]
    }
    hotspot-service = {
      roles = [
        "roles/datastore.user",
        "roles/bigquery.jobUser",
        "roles/aiplatform.user", # Hotspot Confidence Model (batch prediction)
      ]
    }
    forecast-service = {
      roles = [
        "roles/datastore.user",
        "roles/bigquery.jobUser",
        "roles/aiplatform.user", # AQI Forecast Model (batch prediction)
      ]
    }
    alert-service = {
      roles = [
        "roles/datastore.user",
        "roles/aiplatform.user",              # Gemini 3.1 Pro (Pipeline C)
        "roles/firebasecloudmessaging.admin", # FCM send only (was roles/firebase.admin)
      ]
    }
    federation-service = {
      roles = [
        "roles/datastore.user", # submissions (contributions), federationExchange mirror + active pointers
        "roles/bigquery.jobUser",
        "roles/aiplatform.user", # Model Registry get/list/upload/export/update (was aiplatform.admin)
      ]
    }
  }
}

resource "google_service_account" "service" {
  for_each     = local.service_accounts
  project      = var.project_id
  account_id   = "${each.key}-${var.environment_name}"
  display_name = "VayuSetu ${each.key} (${var.environment_name})"
  depends_on   = [google_project_service.required]
}

# Flattens {service -> [roles]} into one {"<service>-<role>" -> {svc, role}}
# map so a single for_each can grant every (service, role) pair --
# equivalent to 20+ nearly-identical resource blocks without the copy-paste
# risk of one of them drifting.
resource "google_project_iam_member" "service_roles" {
  for_each = merge([
    for svc, cfg in local.service_accounts : {
      for role in cfg.roles : "${svc}-${role}" => { svc = svc, role = role }
    }
  ]...)

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.service[each.value.svc].email}"
}
