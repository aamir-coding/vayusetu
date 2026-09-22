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
