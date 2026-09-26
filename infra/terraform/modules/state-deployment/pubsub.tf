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
  # Keyed on the static topic list, not on the topic resources: a for_each
  # over another resource's attributes can't be evaluated during `import`.
  for_each                   = toset(local.pubsub_topics)
  project                    = var.project_id
  name                       = "${each.key}-debug-pull"
  topic                      = google_pubsub_topic.events[each.key].name
  ack_deadline_seconds       = 30
  message_retention_duration = "86400s" # 24h -- plenty for manual debugging pulls

  labels = merge(var.labels, { purpose = "debug" })
}

# =====================================================================
# Week 2 -- alert-service push delivery (hotspot.updated, forecast.updated)
# =====================================================================
#
# Flow: topic -> PUSH subscription -> POST https://<alert-service>/pubsub/...
# with an OIDC token signed as `pubsub_push` below. alert-service
# (src/plugins/pushAuth.ts) verifies signature + audience + this exact SA
# email -- necessary because the Cloud Run service is publicly invokable
# (cloud_run.tf), so the endpoint itself is reachable by anyone.

# Guarantees the Pub/Sub service agent exists before IAM references it (it
# is created lazily on new projects, and the grants below would 400).
resource "google_project_service_identity" "pubsub_agent" {
  provider = google-beta
  project  = var.project_id
  service  = "pubsub.googleapis.com"
}

locals {
  pubsub_service_agent = "serviceAccount:${google_project_service_identity.pubsub_agent.email}"

  # A fixed string, not the service URL: using the URL would make
  # alert-service's env reference its own URI (a dependency cycle).
  # cloud_run.tf passes the same value as PUBSUB_PUSH_AUDIENCE.
  alert_push_audience = "vayusetu-alert-service-${var.environment_name}"

  alert_push_routes = {
    "hotspot.updated"  = "/pubsub/hotspot-updated"
    "forecast.updated" = "/pubsub/forecast-updated"
  }
}

resource "google_service_account" "pubsub_push" {
  project      = var.project_id
  account_id   = "pubsub-push-${var.environment_name}"
  display_name = "Pub/Sub push identity (${var.environment_name})"
  description  = "Identity Pub/Sub signs push OIDC tokens as. Holds no data-plane roles."
}

resource "google_service_account_iam_member" "pubsub_agent_mints_push_tokens" {
  service_account_id = google_service_account.pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_service_agent
}

# Lets Week 4 drop allUsers from alert-service without breaking delivery.
resource "google_cloud_run_v2_service_iam_member" "alert_push_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service["alert-service"].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

# Messages alert-service keeps NACKing (500) land here after
# max_delivery_attempts, instead of retrying for 7 days.
resource "google_pubsub_topic" "alert_service_dead_letter" {
  project    = var.project_id
  name       = "alert-service.dead-letter"
  labels     = var.labels
  depends_on = [google_project_service.required]
}

# A dead-letter topic with no subscription DISCARDS what it receives. This is
# where you inspect failures:
#   gcloud pubsub subscriptions pull alert-service.dead-letter-inspect --limit=10
resource "google_pubsub_subscription" "alert_service_dead_letter_inspect" {
  project                    = var.project_id
  name                       = "alert-service.dead-letter-inspect"
  topic                      = google_pubsub_topic.alert_service_dead_letter.id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s" # 7 days
  labels                     = merge(var.labels, { purpose = "dead-letter" })
}

resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.alert_service_dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_service_agent
}

resource "google_pubsub_subscription" "alert_service_push" {
  for_each = var.enable_alert_push_subscriptions ? local.alert_push_routes : {}

  project              = var.project_id
  name                 = "alert-service-${replace(each.key, ".", "-")}"
  topic                = google_pubsub_topic.events[each.key].id
  ack_deadline_seconds = 60 # geocoding + briefing (Gemini from Week 3) + FCM fan-out

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.service["alert-service"].uri}${each.value}"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.alert_push_audience
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.alert_service_dead_letter.id
    max_delivery_attempts = 10
  }

  labels = merge(var.labels, { consumer = "alert-service" })

  depends_on = [
    google_service_account_iam_member.pubsub_agent_mints_push_tokens,
    google_pubsub_topic_iam_member.dead_letter_publisher,
  ]
}

# Dead-lettering also requires the agent to ack on the SOURCE subscription.
resource "google_pubsub_subscription_iam_member" "dead_letter_source_subscriber" {
  for_each     = var.enable_alert_push_subscriptions ? local.alert_push_routes : {}
  project      = var.project_id
  subscription = google_pubsub_subscription.alert_service_push[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}
