variable "project_id" {
  type        = string
  description = "GCP project id for this state deployment (one project per state, per PRD §3.2's data-sovereignty design -- this is the actual mechanism behind Feature 4's 'not a single citizen photo leaves my state's cloud project' promise)."
}

variable "region" {
  type        = string
  default     = "asia-south1"
  description = "Primary Cloud Run / Artifact Registry / Storage region."
}

variable "firestore_location" {
  type    = string
  default = "asia-south1"
}

variable "bigquery_location" {
  type    = string
  default = "asia-south1"
}

variable "environment_name" {
  type        = string
  description = "Short label used in resource names, e.g. \"ncr-dev\". Keep it short -- it's concatenated onto service-account ids, which have a 30-character GCP limit."

  validation {
    condition     = length(var.environment_name) <= 15
    error_message = "environment_name must be 15 characters or fewer so \"<service-name>-<environment_name>\" stays under GCP's 30-character service-account id limit."
  }
}

variable "labels" {
  type    = map(string)
  default = {}
}

variable "allowed_upload_origins" {
  type        = list(string)
  default     = ["http://localhost:5173", "http://localhost:5174"]
  description = "Origins allowed to PUT directly to the citizen-media bucket via signed URL -- the Citizen PWA and Admin Dashboard dev servers by default; add production Firebase Hosting domains once those exist."
}
