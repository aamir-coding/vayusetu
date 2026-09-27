# Firestore security rules, versioned with the infrastructure. Source of
# truth: packages/firestore-rules/firestore.rules (emulator-tested there).
# Off by default: releasing rules changes what every client can read.
resource "google_firebaserules_ruleset" "firestore" {
  count   = var.deploy_firestore_rules ? 1 : 0
  project = var.project_id
  source {
    files {
      name    = "firestore.rules"
      content = file("${path.module}/../../../../packages/firestore-rules/firestore.rules")
    }
  }
  depends_on = [google_firestore_database.default, google_project_service.required]
}

resource "google_firebaserules_release" "firestore" {
  count        = var.deploy_firestore_rules ? 1 : 0
  project      = var.project_id
  name         = "cloud.firestore"
  ruleset_name = google_firebaserules_ruleset.firestore[0].name

  lifecycle {
    # A new ruleset must exist before the release points at it.
    replace_triggered_by = [google_firebaserules_ruleset.firestore[0]]
  }
}
