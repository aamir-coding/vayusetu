# Firebase Hosting deploys from CI (infra/cloudbuild/<frontend>.yaml).
# The production build config for each frontend -- Firebase web-app config,
# the Maps browser key, the web-push VAPID key -- is assembled HERE from the
# resources that own it and handed to Cloud Build as one Secret Manager
# secret per app. Every value is a public client identifier (it ships in the
# bundle); Secret Manager is the transport so nobody copies keys by hand and
# the build can never drift from Terraform.

locals {
  hosting_apps = {
    citizen-pwa     = { web_app = "citizen", site = var.project_id }
    admin-dashboard = { web_app = "admin", site = google_firebase_hosting_site.admin.site_id }
  }

  frontend_env = {
    for app, cfg in local.hosting_apps : app => merge(
      {
        VITE_USE_MOCKS                    = "false"
        VITE_FIREBASE_API_KEY             = data.google_firebase_web_app_config.frontend[cfg.web_app].api_key
        VITE_FIREBASE_AUTH_DOMAIN         = data.google_firebase_web_app_config.frontend[cfg.web_app].auth_domain
        VITE_FIREBASE_PROJECT_ID          = var.project_id
        VITE_FIREBASE_STORAGE_BUCKET      = data.google_firebase_web_app_config.frontend[cfg.web_app].storage_bucket
        VITE_FIREBASE_MESSAGING_SENDER_ID = data.google_firebase_web_app_config.frontend[cfg.web_app].messaging_sender_id
        VITE_FIREBASE_APP_ID              = google_firebase_web_app.frontend[cfg.web_app].app_id
      },
      app == "admin-dashboard" ? {
        VITE_GOOGLE_MAPS_API_KEY = google_apikeys_key.maps_browser.key_string
        VITE_FIREBASE_VAPID_KEY  = var.firebase_vapid_public_key
      } : {},
    )
  }
}

resource "google_secret_manager_secret" "frontend_env" {
  for_each  = local.hosting_apps
  project   = var.project_id
  secret_id = "frontend-env-${each.key}"
  labels    = var.labels

  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "frontend_env" {
  for_each    = local.hosting_apps
  secret      = google_secret_manager_secret.frontend_env[each.key].id
  secret_data = join("\n", [for k in sort(keys(local.frontend_env[each.key])) : "${k}=${local.frontend_env[each.key][k]}"])
}

resource "google_secret_manager_secret_iam_member" "cloudbuild_reads_frontend_env" {
  for_each  = local.hosting_apps
  project   = var.project_id
  secret_id = google_secret_manager_secret.frontend_env[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloudbuild_deployer.email}"
}

# `firebase deploy --only hosting:<target>`: release to the sites, and read
# the Cloud Run services the /api/v1 rewrites point at (run.developer, above).
resource "google_project_iam_member" "cloudbuild_hosting" {
  for_each = toset([
    "roles/firebasehosting.admin",
    "roles/serviceusage.serviceUsageConsumer", # firebase-tools checks the Hosting API is on
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.cloudbuild_deployer.email}"
}
