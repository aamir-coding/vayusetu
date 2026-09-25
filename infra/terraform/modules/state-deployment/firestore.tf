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

# =====================================================================
# Week 2 -- merge-friendly indexes
# =====================================================================
#
# WEEK 1 BUG FIX: official-side GET /submissions filters on
# jurisdiction.stateCode/districtCode (+ optional status/h3Index/userId)
# ordered by uploadedAt -- no index above serves that, so it would 400
# FAILED_PRECONDITION in the real project. It was never caught because
# NEITHER the unit-test fake NOR the Firestore emulator enforces
# composite indexes. Only a real project does.
#
# Strategy: one (field ASC, <sort> DESC) index per equality-filterable
# field. Firestore MERGES indexes that share the same sort suffix, so any
# combination of equality filters + that sort is served -- versus one
# composite per combination (2^n indexes for n optional filters).
#
# GET /alerts sorts by createdAt, not severity: DB_SCHEMA.md's
# alerts_by_jurisdiction index sorts `severity DESC` on a string, where
# 'critical' sorts LAST. That index is kept (DB_SCHEMA.md is Engineer 4's
# to change) but nothing queries it. See WEEK2_SETUP.md.
locals {
  merge_indexes = {
    submissions_by_state_code    = { collection = "submissions", field = "jurisdiction.stateCode", sort = "uploadedAt" }
    submissions_by_district_code = { collection = "submissions", field = "jurisdiction.districtCode", sort = "uploadedAt" }
    submissions_by_h3_index      = { collection = "submissions", field = "h3Index", sort = "uploadedAt" }
    alerts_by_state_code         = { collection = "alerts", field = "assignedJurisdiction.stateCode", sort = "createdAt" }
    alerts_by_district_code      = { collection = "alerts", field = "assignedJurisdiction.districtCode", sort = "createdAt" }
    alerts_by_status             = { collection = "alerts", field = "status", sort = "createdAt" }
    alerts_by_severity           = { collection = "alerts", field = "severity", sort = "createdAt" }
    alerts_by_type               = { collection = "alerts", field = "type", sort = "createdAt" }
  }
}

resource "google_firestore_index" "merge" {
  for_each   = local.merge_indexes
  project    = var.project_id
  collection = each.value.collection

  fields {
    field_path = each.value.field
    order      = "ASCENDING"
  }
  fields {
    field_path = each.value.sort
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.default]
}
