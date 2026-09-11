resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.required]
}

# Composite indexes straight from docs/context/04_DB_SCHEMA.md's
# "Required composite indexes" list -- provisioned as code so a missing
# index is never a "discovered during the demo" failure mode. If a query
# elsewhere in the codebase ever needs a NEW composite index, Firestore's
# own error message includes a direct console link to create it one-off;
# treat that as a signal to add it here too, not just click the link.

resource "google_firestore_index" "submissions_by_user" {
  project    = var.project_id
  collection = "submissions"
  fields {
    field_path = "userId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "uploadedAt"
    order      = "DESCENDING"
  }
  depends_on = [google_firestore_database.default]
}

resource "google_firestore_index" "submissions_by_status" {
  project    = var.project_id
  collection = "submissions"
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "uploadedAt"
    order      = "DESCENDING"
  }
  depends_on = [google_firestore_database.default]
}

resource "google_firestore_index" "alerts_by_jurisdiction" {
  project    = var.project_id
  collection = "alerts"
  fields {
    field_path = "assignedJurisdiction.stateCode"
    order      = "ASCENDING"
  }
  fields {
    field_path = "assignedJurisdiction.districtCode"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "severity"
    order      = "DESCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
  depends_on = [google_firestore_database.default]
}

resource "google_firestore_index" "hotspots_by_corridor" {
  project    = var.project_id
  collection = "hotspots"
  fields {
    field_path = "corridorId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "timestampHour"
    order      = "DESCENDING"
  }
  depends_on = [google_firestore_database.default]
}

resource "google_firestore_index" "resource_requests_by_jurisdiction" {
  project    = var.project_id
  collection = "resourceRequests"
  fields {
    field_path = "jurisdiction.stateCode"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
  depends_on = [google_firestore_database.default]
}
