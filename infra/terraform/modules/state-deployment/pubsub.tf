# Topic names use dots, matching API_CONTRACTS.md §4.3 verbatim (Pub/Sub
# topic ids allow periods) -- packages/gcp-clients/src/pubsub.ts's
# PubSubEventMap keys these exact same strings. If you ever rename a topic
# here, the TypeScript type and this list both need to change together, or
# publishEvent() will fail at runtime with "topic not found" against a
# type-checker that's perfectly happy.
locals {
  pubsub_topics = [
    "submission.created",
    "analysis.completed",
    "hotspot.updated",
    "forecast.updated",
  ]
}

resource "google_pubsub_topic" "events" {
  for_each   = toset(local.pubsub_topics)
  project    = var.project_id
  name       = each.value
  labels     = var.labels
  depends_on = [google_project_service.required]
}

# One pull subscription per topic purely for manual verification --
# `gcloud pubsub subscriptions pull projects/$PROJECT/subscriptions/<topic>-debug-pull --auto-ack`
# lets you confirm a publish actually landed before the real subscribing
# service (analysis-service, hotspot-service, etc.) exists to consume it.
# Not meant to be the production subscription -- alert-service/
# analysis-service each provision their own real subscription when they
# land (Week 2+).
resource "google_pubsub_subscription" "debug_pull" {
  for_each                   = google_pubsub_topic.events
  project                    = var.project_id
  name                       = "${each.value.name}-debug-pull"
  topic                      = each.value.name
  ack_deadline_seconds       = 30
  message_retention_duration = "86400s" # 24h -- plenty for manual debugging pulls

  labels = merge(var.labels, { purpose = "debug" })
}
