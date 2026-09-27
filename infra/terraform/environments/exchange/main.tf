module "exchange" {
  source        = "../../modules/exchange"
  project_id    = var.project_id
  location      = var.region
  member_states = var.member_states
}
