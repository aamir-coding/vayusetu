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
  description = "Admin dashboard origin used for alert deep links. Defaults to the admin Hosting site https://<project_id>-admin.web.app (firebase.tf). Must be https in deployed envs (FCM rejects non-https web-push links)."
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

variable "openaq_api_key_secret_populated" {
  type        = bool
  default     = false
  description = "Set true only AFTER adding a version to the openaq-api-key secret."
}

# --- Phase 1: AI layer ---

variable "enable_analysis_push_subscription" {
  type        = bool
  default     = false
  description = "Push submission.created to analysis-service. Enable only AFTER its real image is deployed (the hello placeholder would ack and drop every report)."
}

variable "briefing_generator" {
  type        = string
  default     = "gemini"
  description = "alert-service Pipeline C generator: gemini (Gemini Pro, with guards + template fallback) or template."
  validation {
    condition     = contains(["gemini", "template"], var.briefing_generator)
    error_message = "briefing_generator must be gemini or template."
  }
}

variable "gemini_location" {
  type        = string
  default     = "global"
  description = "Vertex AI location for Gemini. The planned models answer only on `global` today (asia-south1 returns 404); switch when Model Garden lists them in India."
}

variable "gemini_triage_model" {
  type    = string
  default = "gemini-3.7-flash"
}

variable "gemini_briefing_model" {
  type    = string
  default = "gemini-3.1-pro-preview"
}

variable "vertex_location" {
  type        = string
  default     = "asia-south1"
  description = "Vertex AI region for AutoML training, endpoints and batch prediction (data residency: India)."
}

variable "hotspot_scorer" {
  type        = string
  default     = "heuristic"
  description = "hotspot-service scorer: heuristic (bootstrap until the first model is registered) | endpoint (online, always-on node) | batch (per-run job)."
  validation {
    condition     = contains(["heuristic", "endpoint", "batch"], var.hotspot_scorer)
    error_message = "hotspot_scorer must be heuristic, endpoint or batch."
  }
}

variable "hotspot_endpoint_id" {
  type        = string
  default     = ""
  description = "Vertex AI endpoint id serving the hotspot model (hotspot_scorer = endpoint)."
}

variable "hotspot_model" {
  type        = string
  default     = ""
  description = "Registry model resource (projects/.../models/<id>); batch scoring uses its `default` alias."
}

variable "enable_hotspot_push_subscription" {
  type        = bool
  default     = false
  description = "Push analysis.completed to hotspot-service (fast path). Enable only after its real image is deployed."
}

variable "enable_model_schedules" {
  type        = bool
  default     = false
  description = "Cloud Scheduler for hotspot hourly scoring and forecast 6-hourly runs. Enable after the images are deployed and the backfills have landed."
}

variable "forecaster" {
  type        = string
  default     = "persistence"
  description = "forecast-service: persistence (bootstrap baseline) | batch (AutoML Forecasting via Vertex AI batch prediction)."
  validation {
    condition     = contains(["persistence", "batch"], var.forecaster)
    error_message = "forecaster must be persistence or batch."
  }
}

variable "forecast_model" {
  type        = string
  default     = ""
  description = "Registry model resource (projects/.../models/<id>) for forecaster = batch; its `default` alias is used."
}

variable "ml_pipeline_submitters" {
  type        = list(string)
  default     = []
  description = "IAM members (e.g. user:someone@example.com) allowed to submit Vertex AI Pipelines runs as the ml-pipelines service account."
}

variable "deploy_firestore_rules" {
  type        = bool
  default     = false
  description = "Release packages/firestore-rules/firestore.rules to the project's Firestore (jurisdiction-scoped reads, no client writes)."
}

# ---- Federation Exchange (federation.tf)
variable "federation_state_code" {
  type        = string
  description = "This deployment's identity on the National Exchange (NCR -> DL, Mumbai-Pune -> MH)."
}

variable "federation_owned_states" {
  type        = list(string)
  description = "States whose summary rows this deployment may publish/replace (NCR spans DL, HR, UP, RJ)."
}

variable "exchange_project_id" {
  type        = string
  default     = ""
  description = "The National Exchange project (modules/exchange). Empty = sync job not scheduled."
}

variable "exchange_project_number" {
  type        = string
  default     = ""
  description = "Exchange project NUMBER, for its Vertex AI service agent's cross-project model read."
}

variable "enable_federation_sync" {
  type        = bool
  default     = false
  description = "Nightly federation-sync schedule (also needs exchange_project_id)."
}

variable "firebase_vapid_public_key" {
  type        = string
  default     = ""
  description = "Web-push VAPID PUBLIC key (Firebase console > Cloud Messaging > Web Push certificates; not Terraform-manageable). Empty = the admin dashboard hides the push opt-in."
}

variable "hotspot_model_every_hours" {
  type        = number
  default     = 1
  description = "With hotspot_scorer = batch: run the model on hours divisible by this (UTC), heuristic between. 6 = one Vertex batch job per 6 h."
  validation {
    condition     = var.hotspot_model_every_hours >= 1 && var.hotspot_model_every_hours <= 24
    error_message = "hotspot_model_every_hours must be 1..24."
  }
}

variable "hotspot_model_hidden_min_confidence" {
  type        = string
  default     = ""
  description = "Hidden-hotspot threshold for MODEL scores (the model's tuned best-F1 threshold, registry label vayusetu-threshold). Empty = same as the heuristic's 0.6."
}

# ---- Monitoring and alerting (monitoring.tf)
variable "alert_emails" {
  type        = list(string)
  default     = []
  description = "On-call emails for alert policies. Empty = incidents show in the console only."
}

variable "alert_5xx_per_5m" {
  type        = number
  default     = 10
  description = "5xx responses per service per 5 minutes before alerting."
}

variable "alert_429_per_5m" {
  type        = number
  default     = 20
  description = "HTTP 429s per service per 5 minutes before alerting."
}

variable "billing_account_id" {
  type        = string
  default     = ""
  description = "Billing account (XXXXXX-XXXXXX-XXXXXX) for the budget alert. Needs billing.budgets.create on the account; empty = no budget resource."
}

variable "monthly_budget" {
  type        = number
  default     = 15000
  description = "Monthly budget in the billing account's currency (INR for this project). Alerts at 50/90/100% actual and 100% forecast."
}
