output "pubsub_topics"             { value = module.ncr_dev.pubsub_topics }
output "pubsub_debug_subscriptions" { value = module.ncr_dev.pubsub_debug_subscriptions }
output "service_account_emails"    { value = module.ncr_dev.service_account_emails }
output "cloud_run_urls"            { value = module.ncr_dev.cloud_run_urls }
output "citizen_media_bucket"      { value = module.ncr_dev.citizen_media_bucket }
output "bigquery_datasets"         { value = module.ncr_dev.bigquery_datasets }
output "artifact_registry_repository" { value = module.ncr_dev.artifact_registry_repository }
