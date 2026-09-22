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
