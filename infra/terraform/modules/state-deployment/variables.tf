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

# ---------------------------------------------------------------- Week 2

variable "default_state_code" {
  type        = string
  default     = "DL"
  description = "Jurisdiction fallback for submission-service/alert-service when geocoding can't resolve a point (and the only value used if no Maps key is configured)."
}

variable "default_district_code" {
  type        = string
  default     = "DL-CENTRAL"
  description = "District half of the jurisdiction fallback. Team convention code, not a numeric LGD code -- see WEEK2_SETUP.md."
}

variable "maps_api_key_secret_populated" {
  type        = bool
  default     = false
  description = "Set true only AFTER `gcloud secrets versions add google-maps-api-key ...`. Cloud Run refuses to deploy a revision that references a secret with no versions, so the GOOGLE_MAPS_API_KEY env is wired only when this is true."
}

variable "dashboard_base_url" {
  type        = string
  default     = null
  description = "Admin dashboard origin used for alert deep links. Defaults to the Firebase Hosting default domain https://<project_id>.web.app. Must be https in deployed envs (FCM rejects non-https web-push links)."
}

variable "enable_alert_push_subscriptions" {
  type        = bool
  default     = false
  description = "Create the Pub/Sub PUSH subscriptions that deliver hotspot.updated/forecast.updated to alert-service. Leave false until alert-service's real image has been deployed once: the Week 1 hello-world placeholder answers every push with 200, which Pub/Sub treats as a successful ack -- real events would be silently dropped."
}

variable "enable_ci_triggers" {
  type        = bool
  default     = false
  description = "Create Cloud Build GitHub triggers. Requires the one-time manual step of installing the Cloud Build GitHub App on the repo and connecting it in the console first (see WEEK2_SETUP.md); applying with this true before that fails."
}

variable "github_owner" {
  type        = string
  default     = ""
  description = "GitHub org/user that owns the monorepo (required when enable_ci_triggers = true)."
}

variable "github_repo" {
  type        = string
  default     = ""
  description = "GitHub repository name of the monorepo (required when enable_ci_triggers = true)."
}

variable "ci_branch_regex" {
  type        = string
  default     = "^main$"
  description = "Branch whose pushes deploy, and which PRs must target to be validated."
}

# --- Ingestion (ingestion.tf) ---

variable "corridor_ids" {
  type        = list(string)
  default     = ["ncr-airshed"]
  description = "Corridor ids (data/seed/corridors.json) this deployment ingests and scores. Data sovereignty: a state project holds only its own corridors."
}

variable "ingestion_image" {
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/job:latest"
  description = "Initial image for the ingestion Cloud Run Jobs. Public placeholder; CI replaces it (Terraform ignores image drift)."
}

variable "cpcb_api_key_secret_populated" {
  type        = bool
  default     = false
  description = "Set true only AFTER adding a version to the cpcb-api-key secret (data.gov.in key). Jobs referencing an empty secret fail to deploy."
}

variable "enable_ingestion_schedules" {
  type        = bool
  default     = false
  description = "Create the Cloud Scheduler triggers. Leave false until the real ingestion image is deployed and migrate/cpcb/seed have run once by hand."
}
