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

  # Remote state -- swap this for a real backend before more than one
  # person applies against this environment. Uncomment once the state
  # bucket exists (see infra/terraform/README.md's "Remote state"
  # section); until then, state is local, which is fine for one engineer
  # bootstrapping Day 1 but WILL conflict the moment a second person runs
  # `apply` from a different machine.
  # backend "gcs" {
  #   bucket = "vayusetu-mh-dev-tfstate"
  #   prefix = "terraform/state"
  # }
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
