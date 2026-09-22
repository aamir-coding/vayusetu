variable "project_id" {
  type        = string
  description = "The dev NCR GCP project id, created ahead of time via `gcloud projects create` (see infra/terraform/README.md)."
}

variable "region" {
  type    = string
  default = "asia-south1"
}
