# Firebase App Check for the citizen PWA (audit H1). An anonymous Firebase
# account costs a script nothing, so "distinct citizens" can be minted; an
# App Check token proves a request came from the real PWA in a real browser
# (reCAPTCHA Enterprise attestation, score-based: no challenge for people).
#
# OFF by default. Rollout, one apply each:
#   1. enable_app_check = true, app_check_mode = "monitor"
#      -> creates the key, registers it with App Check, and ships the site
#         key in the citizen build; submission-service logs, never rejects.
#   2. Rebuild + deploy the citizen PWA, watch the "App Check token" warnings
#      in submission-service logs drop to ~0 for real traffic.
#   3. app_check_mode = "enforce".
# Verification is local JWT validation against App Check's public JWKS:
# submission-service needs no extra IAM role.

resource "google_recaptcha_enterprise_key" "citizen" {
  count        = var.enable_app_check ? 1 : 0
  project      = var.project_id
  display_name = "VayuSetu citizen PWA App Check (${var.environment_name})"
  labels       = var.labels

  web_settings {
    integration_type  = "SCORE"
    allow_all_domains = false
    allowed_domains   = concat(["${var.project_id}.web.app", "${var.project_id}.firebaseapp.com"], var.app_check_extra_domains)
  }
  depends_on = [google_project_service.required]
}

resource "google_firebase_app_check_recaptcha_enterprise_config" "citizen" {
  provider  = google-beta
  count     = var.enable_app_check ? 1 : 0
  project   = var.project_id
  app_id    = google_firebase_web_app.frontend["citizen"].app_id
  site_key  = google_recaptcha_enterprise_key.citizen[0].name
  token_ttl = "3600s"
}
