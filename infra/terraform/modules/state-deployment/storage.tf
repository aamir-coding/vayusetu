locals {
  citizen_hosting_origins = ["https://${var.project_id}.web.app", "https://${var.project_id}.firebaseapp.com"]
}

resource "google_storage_bucket" "citizen_media" {
  project                     = var.project_id
  name                        = "${var.project_id}-citizen-media"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = var.environment_name != "prod"

  # The PWA PUTs photos/voice notes straight to a signed URL, so the bucket
  # must allow the citizen Hosting origins. Before this, only the localhost
  # dev ports were allowed and every upload from the DEPLOYED PWA failed the
  # CORS preflight (found in the 27 Sep demo rehearsal).
  cors {
    origin          = distinct(concat(var.allowed_upload_origins, local.citizen_hosting_origins))
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

  # Audit M5 (DPDP data minimisation): citizens' photos and voice notes are
  # personal data. Once set, objects older than N days are DELETED -- the
  # report's analysis, severity and location stay in Firestore/BigQuery, only
  # the raw media goes. 0 = keep forever (the pre-audit behaviour).
  dynamic "lifecycle_rule" {
    for_each = var.citizen_media_retention_days > 0 ? [var.citizen_media_retention_days] : []
    content {
      condition {
        age = lifecycle_rule.value
      }
      action {
        type = "Delete"
      }
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
