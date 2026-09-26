# Empty secret CONTAINERS only -- Terraform state should never hold a real
# API key in plaintext. Populate the actual value out-of-band:
#   gcloud secrets versions add google-maps-api-key --data-file=- <<< "AIza..."
# (matches this repo's existing .gitignore discipline around
# service-account*.json / *-credentials.json -- same principle, applied to
# Terraform.)
locals {
  secret_ids = [
    "google-maps-api-key",
    "sms-gateway-credentials",
    "whatsapp-gateway-credentials",
    "cpcb-api-key",
    "openaq-api-key", # OpenAQ v3: CPCB station registry + measured history
  ]
}

resource "google_secret_manager_secret" "secrets" {
  for_each  = toset(local.secret_ids)
  project   = var.project_id
  secret_id = each.value
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}
