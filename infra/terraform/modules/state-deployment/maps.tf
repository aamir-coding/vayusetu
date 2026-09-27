# Browser key for the Maps JavaScript API (admin HotspotMap). Browser keys
# ship in the bundle by design; what protects them is this restriction set:
# one API, and only our Hosting origins (+ the local Vite ports).
resource "google_apikeys_key" "maps_browser" {
  project      = var.project_id
  name         = "maps-browser-${var.environment_name}"
  display_name = "VayuSetu Maps JS browser key (${var.environment_name})"

  restrictions {
    api_targets {
      service = "maps-backend.googleapis.com"
    }
    browser_key_restrictions {
      allowed_referrers = concat(
        flatten([for site in [var.project_id, "${var.project_id}-admin"] : [
          "https://${site}.web.app/*",
          "https://${site}.firebaseapp.com/*",
        ]]),
        ["http://localhost:5173/*", "http://localhost:5174/*"],
      )
    }
  }
  depends_on = [google_project_service.required]
}
