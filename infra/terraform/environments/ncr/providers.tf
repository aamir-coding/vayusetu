terraform {
  required_version = ">= 1.7.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }

  # Remote state in a versioned bucket in this project (GCS locks it, so two
  # people can't apply at once). Migrated from local state with
  # infra/terraform/scripts/migrate-state.ps1; see README "Remote state".
  backend "gcs" {
    bucket = "vayusetu-ncr-dev-tfstate"
    prefix = "terraform/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  # Bill API quota to this project even under user ADC -- apikeys.googleapis.com
  # (maps.tf) and a few others refuse user credentials without a quota project.
  user_project_override = true
  billing_project       = var.project_id
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
  # Bill API quota to this project even under user ADC -- apikeys.googleapis.com
  # (maps.tf) and a few others refuse user credentials without a quota project.
  user_project_override = true
  billing_project       = var.project_id
}
