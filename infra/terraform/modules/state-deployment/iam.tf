# One service account per Cloud Run service, each granted only the roles
# that service's own documented job needs (ARCHITECTURE_OVERVIEW.md's GCP
# Service Map + each service's repo-map entry). submission-service is the
# only one with real code behind it in Week 1; the rest are provisioned
# ahead of need so Week 2/3 engineers land into a working IAM setup
# instead of each requesting their own grants ad hoc.
locals {
  service_accounts = {
    submission-service = {
      roles = [
        "roles/datastore.user",                 # Firestore read/write
        "roles/pubsub.publisher",               # submission.created
        "roles/storage.objectAdmin",            # citizen-media bucket
        "roles/secretmanager.secretAccessor",   # Maps API key
        "roles/iam.serviceAccountTokenCreator", # self-sign upload URLs from Cloud Run's metadata credential
      ]
    }
    analysis-service = {
      roles = [
        "roles/datastore.user",
        "roles/pubsub.subscriber", # submission.created
        "roles/pubsub.publisher",  # analysis.completed
        "roles/aiplatform.user",   # Gemini 3.7 Flash (Pipeline A)
        "roles/storage.objectViewer",
        "roles/secretmanager.secretAccessor",
      ]
    }
    hotspot-service = {
      roles = [
        "roles/datastore.user",
        "roles/pubsub.subscriber", # analysis.completed
        "roles/pubsub.publisher",  # hotspot.updated
        "roles/bigquery.dataEditor",
        "roles/bigquery.jobUser",
        "roles/aiplatform.user", # Hotspot Confidence Model
      ]
    }
    forecast-service = {
      roles = [
        "roles/datastore.user",
        "roles/pubsub.publisher", # forecast.updated
        "roles/bigquery.dataEditor",
        "roles/bigquery.jobUser",
        "roles/aiplatform.user", # AQI Forecast Model
      ]
    }
    alert-service = {
      roles = [
        "roles/datastore.user",
        "roles/pubsub.subscriber",            # hotspot.updated + forecast.updated
        "roles/aiplatform.user",              # Gemini 3.1 Pro (Pipeline C)
        "roles/secretmanager.secretAccessor", # SMS/WhatsApp gateway creds
        "roles/firebase.admin",               # FCM dispatch via Firebase Admin SDK
      ]
    }
    federation-service = {
      roles = [
        "roles/bigquery.dataEditor",
        "roles/bigquery.jobUser",
        "roles/aiplatform.admin", # publish to / import from Model Registry -- a step above .user
        "roles/storage.objectAdmin",
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
