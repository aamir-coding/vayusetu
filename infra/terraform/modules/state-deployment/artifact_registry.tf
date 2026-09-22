resource "google_artifact_registry_repository" "containers" {
  project       = var.project_id
  location      = var.region
  repository_id = "vayusetu"
  format        = "DOCKER"
  description   = "Container images for every VayuSetu Cloud Run service."
  depends_on    = [google_project_service.required]
}
