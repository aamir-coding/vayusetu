module "mh_dev" {
  source           = "../../modules/state-deployment"
  project_id       = var.project_id
  region           = var.region
  environment_name = "mh-dev"

  # Federation Exchange: Mumbai-Pune publishes as MH (single-state corridor).
  federation_state_code   = "MH"
  federation_owned_states = ["MH"]

  # Jurisdiction fallback when geocoding cannot resolve a point.
  default_state_code      = "MH"
  default_district_code   = "MH-PUNE"
  exchange_project_id     = var.exchange_project_id
  exchange_project_number = var.exchange_project_number
  enable_federation_sync  = var.enable_federation_sync

  # Week 2 (see WEEK2_SETUP.md for when to flip each)
  maps_api_key_secret_populated   = var.maps_api_key_secret_populated
  enable_alert_push_subscriptions = var.enable_alert_push_subscriptions
  enable_ci_triggers              = var.enable_ci_triggers
  github_owner                    = var.github_owner
  github_repo                     = var.github_repo
  dashboard_base_url              = var.dashboard_base_url
  firebase_vapid_public_key       = var.firebase_vapid_public_key

  # Ingestion (ingestion.tf)
  corridor_ids                    = ["mumbai-pune-corridor"]
  cpcb_api_key_secret_populated   = var.cpcb_api_key_secret_populated
  openaq_api_key_secret_populated = var.openaq_api_key_secret_populated
  enable_ingestion_schedules      = var.enable_ingestion_schedules

  # Phase 1 AI layer
  enable_analysis_push_subscription = var.enable_analysis_push_subscription
  enable_hotspot_push_subscription  = var.enable_hotspot_push_subscription
  enable_model_schedules            = var.enable_model_schedules
  hotspot_scorer                    = var.hotspot_scorer
  hotspot_model                     = var.hotspot_model
  forecaster                        = var.forecaster
  briefing_generator                = var.briefing_generator
  deploy_firestore_rules            = var.deploy_firestore_rules
  forecast_model                    = var.forecast_model
  ml_pipeline_submitters            = var.ml_pipeline_submitters

  labels = {
    corridor    = "mumbai-pune-corridor"
    environment = "dev"
    managed_by  = "terraform"
  }
}
