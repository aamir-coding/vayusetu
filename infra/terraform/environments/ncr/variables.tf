variable "project_id" {
  type        = string
  description = "The dev NCR GCP project id, created ahead of time via `gcloud projects create` (see infra/terraform/README.md)."
}

variable "region" {
  type    = string
  default = "asia-south1"
}

# ---------------------------------------------------------------- Week 2
# Each defaults to the safe/off state; flip in terraform.tfvars as you
# complete the matching manual step in WEEK2_SETUP.md.

variable "maps_api_key_secret_populated" {
  type    = bool
  default = false
}

variable "enable_alert_push_subscriptions" {
  type    = bool
  default = false
}

variable "enable_ci_triggers" {
  type    = bool
  default = false
}

variable "github_owner" {
  type    = string
  default = ""
}

variable "github_repo" {
  type    = string
  default = ""
}

variable "dashboard_base_url" {
  type    = string
  default = null
}
