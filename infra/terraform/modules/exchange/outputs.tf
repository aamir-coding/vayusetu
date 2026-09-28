output "project_id" { value = var.project_id }
output "dataset" { value = google_bigquery_dataset.exchange.dataset_id }
# The agent each state grants cross-project model read (publish direction).
output "vertex_agent" { value = google_project_service_identity.vertex_agent.email }
output "portal_url" { value = "https://${google_firebase_hosting_site.portal.site_id}.web.app" }
output "portal_deployer" { value = google_service_account.portal_deployer.email }
