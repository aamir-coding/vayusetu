resource "google_storage_bucket" "citizen_media" {
  project                     = var.project_id
  name                        = "${var.project_id}-citizen-media"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = var.environment_name != "prod"

  cors {
    origin          = var.allowed_upload_origins
    method          = ["GET", "PUT", "POST"]
    response_header = ["*"]
    max_age_seconds = 3600
  }

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "advisory_audio" {
  project                     = var.project_id
  name                        = "${var.project_id}-advisory-audio"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = var.environment_name != "prod"
  depends_on                  = [google_project_service.required]
}

resource "google_storage_bucket" "model_artifacts" {
  project                     = var.project_id
  name                        = "${var.project_id}-model-artifacts"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = var.environment_name != "prod"
  depends_on                  = [google_project_service.required]
}
