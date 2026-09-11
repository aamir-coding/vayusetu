module "ncr_dev" {
  source           = "../../modules/state-deployment"
  project_id       = var.project_id
  region           = var.region
  environment_name = "ncr-dev"

  labels = {
    corridor    = "ncr-airshed"
    environment = "dev"
    managed_by  = "terraform"
  }
}
