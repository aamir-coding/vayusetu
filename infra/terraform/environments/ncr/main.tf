module "ncr_dev" {
  source           = "../../modules/state-deployment"
  project_id       = var.project_id
  region           = var.region
  environment_name = "ncr-dev"

  # Week 2 (see WEEK2_SETUP.md for when to flip each)
  maps_api_key_secret_populated   = var.maps_api_key_secret_populated
  enable_alert_push_subscriptions = var.enable_alert_push_subscriptions
  enable_ci_triggers              = var.enable_ci_triggers
  github_owner                    = var.github_owner
  github_repo                     = var.github_repo
  dashboard_base_url              = var.dashboard_base_url

  labels = {
    corridor    = "ncr-airshed"
    environment = "dev"
    managed_by  = "terraform"
  }
}
