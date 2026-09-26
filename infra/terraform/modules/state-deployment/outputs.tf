output "project_id" {
  value = var.project_id
}

output "pubsub_topics" {
  value = { for k, v in google_pubsub_topic.events : k => v.id }
}

output "pubsub_debug_subscriptions" {
  value = { for k, v in google_pubsub_subscription.debug_pull : k => v.id }
}

output "service_account_emails" {
  value = { for k, v in google_service_account.service : k => v.email }
}

output "cloud_run_urls" {
  value = { for k, v in google_cloud_run_v2_service.service : k => v.uri }
}

output "citizen_media_bucket" {
  value = google_storage_bucket.citizen_media.name
}

output "bigquery_datasets" {
  value = {
    core                = google_bigquery_dataset.core.dataset_id
    federation_exchange = google_bigquery_dataset.federation_exchange.dataset_id
  }
}

output "artifact_registry_repository" {
  value = google_artifact_registry_repository.containers.name
}

# ---------------------------------------------------------------- Week 2

output "pubsub_push_service_account" {
  description = "Identity Pub/Sub signs alert-service push tokens as (alert-service's PUBSUB_PUSH_SA_EMAIL)."
  value       = google_service_account.pubsub_push.email
}

output "alert_push_audience" {
  description = "OIDC audience on push tokens (alert-service's PUBSUB_PUSH_AUDIENCE)."
  value       = local.alert_push_audience
}

output "alert_push_subscriptions" {
  description = "Empty until enable_alert_push_subscriptions = true."
  value       = [for s in google_pubsub_subscription.alert_service_push : s.name]
}

output "alert_dead_letter_subscription" {
  description = "Pull from this to inspect events alert-service failed on repeatedly."
  value       = google_pubsub_subscription.alert_service_dead_letter_inspect.name
}

output "cloudbuild_deployer_service_account" {
  value = google_service_account.cloudbuild_deployer.email
}

output "ci_triggers" {
  description = "Empty until enable_ci_triggers = true."
  value       = concat([for t in google_cloudbuild_trigger.pr : t.name], [for t in google_cloudbuild_trigger.main : t.name])
}
