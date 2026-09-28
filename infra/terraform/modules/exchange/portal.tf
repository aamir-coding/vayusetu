# The national landing page (apps/portal): ONE link for the whole project,
# https://<portal_site_id>.web.app, that sends citizens and officials to their
# own state's apps. It is static and holds no data. It lives here because the
# Exchange is the only project no single state owns.
#
# Deploy (manual, from the repo root):
#   gcloud builds submit --project $P --region asia-south1 --config infra/cloudbuild/portal.yaml \
#     --gcs-source-staging-dir=gs://$P-portal-build/source \
#     --service-account=projects/$P/serviceAccounts/cloudbuild-portal@$P.iam.gserviceaccount.com .

resource "google_firebase_project" "default" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.required]
}

resource "google_firebase_hosting_site" "portal" {
  provider   = google-beta
  project    = var.project_id
  site_id    = var.portal_site_id
  depends_on = [google_firebase_project.default]
}

# Cloud Build runs as this SA and can do exactly one thing: publish Hosting
# releases. No Cloud Run, no data, no IAM.
resource "google_service_account" "portal_deployer" {
  project      = var.project_id
  account_id   = "cloudbuild-portal"
  display_name = "Cloud Build deployer (portal)"
  description  = "Deploys apps/portal to Firebase Hosting. Nothing else."
  depends_on   = [google_project_service.required]
}

resource "google_project_iam_member" "portal_deployer" {
  for_each = toset([
    "roles/firebasehosting.admin", # create and release Hosting versions
    "roles/logging.logWriter",     # required for builds with a user-specified SA
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.portal_deployer.email}"
}

# Source staging for `gcloud builds submit`. Declared here (not the implicit
# <project>_cloudbuild bucket, which only exists after a first submit) so the
# deployer's read grant can be applied before anyone has built.
resource "google_storage_bucket" "portal_build" {
  project                     = var.project_id
  name                        = "${var.project_id}-portal-build"
  location                    = var.location
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels                      = var.labels
  lifecycle_rule {
    condition { age = 7 }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "portal_deployer_reads_source" {
  bucket = google_storage_bucket.portal_build.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.portal_deployer.email}"
}
