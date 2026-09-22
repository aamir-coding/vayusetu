# Every API any Week-1-through-Week-4 service touches, enabled up front.
# Deliberately provisioning ahead of the code that will use it (e.g.
# aiplatform.googleapis.com before analysis-service exists) -- the
# alternative is every engineer separately remembering to enable their
# own APIs on an already-shared project, which is exactly the kind of
# silent-drift API_CONTRACTS.md's whole design exists to prevent.
locals {
  required_apis = [
    "run.googleapis.com",                 # Cloud Run services
    "firestore.googleapis.com",           # Operational data store
    "firebase.googleapis.com",            # Turns this project into a Firebase project (see firebase.tf)
    "identitytoolkit.googleapis.com",     # Firebase Authentication
    "pubsub.googleapis.com",              # submission.created / analysis.completed / hotspot.updated / forecast.updated
    "bigquery.googleapis.com",            # Analytical layer (DB_SCHEMA.md, Engineer 4)
    "secretmanager.googleapis.com",       # Maps / SMS / WhatsApp gateway credentials
    "storage.googleapis.com",             # Citizen media, advisory audio, model artifacts
    "artifactregistry.googleapis.com",    # Docker images for every Cloud Run service
    "cloudbuild.googleapis.com",          # CI/CD (Week 2)
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",      # Signed-URL generation from Cloud Run's metadata credential
    "cloudresourcemanager.googleapis.com",
    "geocoding-backend.googleapis.com",   # submission-service's reverseGeocode.ts
    "aiplatform.googleapis.com",          # Gemini + AutoML (Engineer 3, Week 2+)
    "speech.googleapis.com",              # Voice-note transcription (Engineer 3)
    "texttospeech.googleapis.com",        # Advisory/alert audio synthesis
    "translate.googleapis.com",           # Static UI-string localization
    "cloudscheduler.googleapis.com",      # Hourly/6-hourly model-scoring triggers (Week 2+)
  ]
}

resource "google_project_service" "required" {
  for_each                   = toset(local.required_apis)
  project                    = var.project_id
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}
