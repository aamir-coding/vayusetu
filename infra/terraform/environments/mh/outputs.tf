output "pubsub_topics" { value = module.mh_dev.pubsub_topics }
output "pubsub_debug_subscriptions" { value = module.mh_dev.pubsub_debug_subscriptions }
output "service_account_emails" { value = module.mh_dev.service_account_emails }
output "cloud_run_urls" { value = module.mh_dev.cloud_run_urls }
output "citizen_media_bucket" { value = module.mh_dev.citizen_media_bucket }
output "bigquery_datasets" { value = module.mh_dev.bigquery_datasets }
output "artifact_registry_repository" { value = module.mh_dev.artifact_registry_repository }
output "pubsub_push_service_account" { value = module.mh_dev.pubsub_push_service_account }
output "alert_push_audience" { value = module.mh_dev.alert_push_audience }
output "alert_push_subscriptions" { value = module.mh_dev.alert_push_subscriptions }
output "alert_dead_letter_subscription" { value = module.mh_dev.alert_dead_letter_subscription }
output "cloudbuild_deployer_service_account" { value = module.mh_dev.cloudbuild_deployer_service_account }
output "ci_triggers" { value = module.mh_dev.ci_triggers }
output "firebase_web_config" { value = module.mh_dev.firebase_web_config }
output "hosting_sites" { value = module.mh_dev.hosting_sites }
output "maps_browser_key" {
  value     = module.mh_dev.maps_browser_key
  sensitive = true
}
output "federation_identity" { value = module.mh_dev.federation_identity }
