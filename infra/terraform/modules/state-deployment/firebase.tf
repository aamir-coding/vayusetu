# Turns var.project_id into an actual Firebase project -- required before
# Firebase Authentication (phone-OTP for citizens, custom claims for
# officials) works at all. This is a google-beta resource; if it errors
# on `apply` (the beta provider occasionally lags), the manual fallback
# is `firebase projects:addfirebase <project-id>` via the Firebase CLI,
# then re-run `terraform plan` -- it will show this resource as already
# satisfied rather than trying to create it twice.
resource "google_firebase_project" "default" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.required]
}

# Web apps for the two frontends. Their config (apiKey, appId, ...) is a
# PUBLIC client identifier, not a secret -- it ships inside every browser
# bundle; access is enforced by Auth + Firestore rules + the API layer.
resource "google_firebase_web_app" "frontend" {
  provider        = google-beta
  for_each        = toset(["citizen", "admin"])
  project         = var.project_id
  display_name    = "VayuSetu ${each.key} (${var.environment_name})"
  deletion_policy = "DELETE"
  depends_on      = [google_firebase_project.default]
}

data "google_firebase_web_app_config" "frontend" {
  provider   = google-beta
  for_each   = google_firebase_web_app.frontend
  project    = var.project_id
  web_app_id = each.value.app_id
}

# The default site (<project>.web.app) serves the citizen PWA; officials get
# their own site so the two apps deploy and cache independently.
resource "google_firebase_hosting_site" "admin" {
  provider = google-beta
  project  = var.project_id
  site_id  = "${var.project_id}-admin"
  app_id   = google_firebase_web_app.frontend["admin"].app_id
}
