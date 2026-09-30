# Monitoring and alerting (Phase 3). Everything here is per state project and
# tells an operator which RUNBOOK.md section to open. Policies cost nothing;
# notifications go to var.alert_emails (empty = policies still show incidents
# in the console, nobody is emailed).
#
#   5xx errors ............ a service is failing requests          RUNBOOK "5xx spike"
#   429 burst ............. platform/app throttling (27 Sep incident) RUNBOOK "429 / billing"
#   job failed ............ any Cloud Run Job execution failed     RUNBOOK "Job failed"
#   data freshness ........ a scheduled job hasn't SUCCEEDED lately RUNBOOK "Stale data"
#   dead letters .......... Pub/Sub gave up on an event            RUNBOOK "Dead letters"
#   uptime ................ submission-service /health            RUNBOOK "Service down"
#   fallback routing ...... an alert could not be geocoded (L9)    RUNBOOK "Alert routed to state"
#   budget ................ spend vs var.monthly_budget            RUNBOOK "Budget"

locals {
  monitored_services = keys(local.cloud_run_services)

  # Scheduled work that must keep SUCCEEDING, and how long a gap means the
  # data behind the product is stale. Only sub-daily jobs (Monitoring's
  # absence window can't span a daily schedule plus slack); daily jobs are
  # covered by the job-failure policy.
  freshness_windows = merge(
    var.enable_ingestion_schedules ? {
      "ingest-weather-${var.environment_name}" = "10800s" # hourly -> 3 h
      "ingest-rollup-${var.environment_name}"  = "10800s" # hourly -> 3 h
      "ingest-openaq-${var.environment_name}"  = "46800s" # 6-hourly -> 13 h
    } : {},
    var.enable_model_schedules ? {
      "hotspot-score-hourly-${var.environment_name}" = "10800s" # hourly -> 3 h (the live heatmap)
      "forecast-score-${var.environment_name}"       = "46800s" # 6-hourly -> 13 h
    } : {},
  )

  dead_letter_topics = {
    analysis-service = google_pubsub_topic.analysis_service_dead_letter.name
    alert-service    = google_pubsub_topic.alert_service_dead_letter.name
    hotspot-service  = google_pubsub_topic.hotspot_service_dead_letter.name
  }

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]
  runbook               = "https://github.com/aamir-coding/vayusetu/blob/main/docs/RUNBOOK.md"
}

resource "google_monitoring_notification_channel" "email" {
  for_each     = toset(var.alert_emails)
  project      = var.project_id
  display_name = "VayuSetu on-call (${each.value})"
  type         = "email"
  labels       = { email_address = each.value }
  depends_on   = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "service_5xx" {
  for_each     = toset(local.monitored_services)
  project      = var.project_id
  display_name = "[${var.environment_name}] ${each.key}: 5xx errors"
  combiner     = "OR"

  conditions {
    display_name = "more than ${var.alert_5xx_per_5m} 5xx responses in 5 min"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${each.key}-${var.environment_name}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_5xx_per_5m
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    content   = "${each.key} is returning server errors. Open the service's logs (severity>=ERROR), then follow RUNBOOK.md, section \"5xx spike\": ${local.runbook}"
    mime_type = "text/markdown"
  }
  notification_channels = local.notification_channels
  alert_strategy {
    auto_close = "3600s"
  }
  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "service_429" {
  project      = var.project_id
  display_name = "[${var.environment_name}] 429 burst (platform or app throttling)"
  combiner     = "OR"

  conditions {
    display_name = "more than ${var.alert_429_per_5m} HTTP 429 in 5 min on any service"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code = \"429\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_429_per_5m
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.labels.service_name"]
      }
    }
  }

  documentation {
    content   = "429s with ~0 ms latency and a 14-byte body come from Cloud Run itself (billing disabled/re-enabling, or max instances). Slower 429s with an ApiError body are the per-user app limiter. RUNBOOK.md, section \"429 / billing\": ${local.runbook}"
    mime_type = "text/markdown"
  }
  notification_channels = local.notification_channels
  alert_strategy {
    auto_close = "3600s"
  }
  depends_on = [google_project_service.required]
}

# Audit L9: alert-service routes an alert whose cell centre does not geocode
# to the whole STATE instead of its district. The alert is not lost, but no
# district officer is paged for it, so an operator should know.
resource "google_monitoring_alert_policy" "alert_fallback_routing" {
  project      = var.project_id
  display_name = "[${var.environment_name}] alert-service: alert routed to state fallback (no district)"
  combiner     = "OR"

  conditions {
    display_name = "\"Cell centre did not geocode\" logged"
    condition_matched_log {
      filter = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"alert-service-${var.environment_name}\" AND jsonPayload.msg = \"Cell centre did not geocode; routed to fallback state\""
    }
  }

  documentation {
    content   = "A hotspot alert's cell centre did not reverse-geocode, so it went to state admins only (fallback state). Check the Maps key and quota, then reassign the alert to its district from the Alert Queue. RUNBOOK.md, section \"Alert routed to state\": ${local.runbook}"
    mime_type = "text/markdown"
  }
  notification_channels = local.notification_channels
  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "86400s"
  }
  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "job_failed" {
  project      = var.project_id
  display_name = "[${var.environment_name}] Cloud Run Job execution failed"
  combiner     = "OR"

  conditions {
    display_name = "any failed execution"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.labels.job_name"]
      }
    }
  }

  documentation {
    content   = "A job execution failed (retries exhausted). `gcloud run jobs executions list --job <job>`, then read its logs. RUNBOOK.md, section \"Job failed\": ${local.runbook}"
    mime_type = "text/markdown"
  }
  notification_channels = local.notification_channels
  alert_strategy {
    auto_close = "86400s"
  }
  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "data_freshness" {
  for_each     = local.freshness_windows
  project      = var.project_id
  display_name = "[${var.environment_name}] Stale data: ${each.key} has not succeeded"
  combiner     = "OR"

  conditions {
    display_name = "no successful execution for ${trimsuffix(each.value, "s")} s"
    condition_absent {
      filter   = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"${each.key}\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"succeeded\""
      duration = each.value
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  documentation {
    content   = "The data this job feeds (heatmap, forecasts, weather/AQ features) is going stale. Check Cloud Scheduler for the job, then its last executions. RUNBOOK.md, section \"Stale data\": ${local.runbook}"
    mime_type = "text/markdown"
  }
  notification_channels = local.notification_channels
  depends_on            = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "dead_letters" {
  for_each     = local.dead_letter_topics
  project      = var.project_id
  display_name = "[${var.environment_name}] ${each.key}: events dead-lettered"
  combiner     = "OR"

  conditions {
    display_name = "any message published to ${each.value}"
    condition_threshold {
      filter          = "resource.type = \"pubsub_topic\" AND resource.labels.topic_id = \"${each.value}\" AND metric.type = \"pubsub.googleapis.com/topic/send_message_operation_count\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    content   = "Pub/Sub gave up delivering an event to ${each.key} after max attempts: a report, hotspot or forecast was not processed. RUNBOOK.md, section \"Dead letters\" (inspect + replay): ${local.runbook}"
    mime_type = "text/markdown"
  }
  notification_channels = local.notification_channels
  alert_strategy {
    auto_close = "86400s"
  }
  depends_on = [google_project_service.required]
}

# Black-box check of the citizen entry point (the service every report goes through).
resource "google_monitoring_uptime_check_config" "submission_health" {
  project      = var.project_id
  display_name = "[${var.environment_name}] submission-service /health"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = trimprefix(google_cloud_run_v2_service.service["submission-service"].uri, "https://")
    }
  }
  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "uptime" {
  project      = var.project_id
  display_name = "[${var.environment_name}] submission-service is down"
  combiner     = "OR"

  conditions {
    display_name = "uptime check failing"
    condition_threshold {
      filter          = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id = \"${google_monitoring_uptime_check_config.submission_health.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.project_id"]
      }
    }
  }

  documentation {
    content   = "Citizens cannot submit reports. Check billing first (27 Sep incident), then the latest revision. RUNBOOK.md, section \"Service down\": ${local.runbook}"
    mime_type = "text/markdown"
  }
  notification_channels = local.notification_channels
  depends_on            = [google_project_service.required]
}

# Needs billing.budgets.create on the BILLING ACCOUNT (not the project), so
# it is opt-in: set billing_account_id once Chirag confirms that access.
resource "google_billing_budget" "monthly" {
  count           = var.billing_account_id != "" ? 1 : 0
  billing_account = var.billing_account_id
  display_name    = "VayuSetu ${var.environment_name} monthly"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }
  amount {
    specified_amount {
      units = tostring(var.monthly_budget)
    }
  }
  dynamic "threshold_rules" {
    for_each = [0.5, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
  all_updates_rule {
    monitoring_notification_channels = local.notification_channels
    disable_default_iam_recipients   = false # billing admins are emailed too
  }
  depends_on = [google_project_service.required]
}

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_monitoring_dashboard" "ops" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "VayuSetu ${var.environment_name} — operations"
    mosaicLayout = {
      columns = 12
      tiles = [
        for i, t in [
          { title = "Requests by service (per min)", filter = "resource.type=\"cloud_run_revision\" metric.type=\"run.googleapis.com/request_count\"", group = "resource.label.service_name", aligner = "ALIGN_RATE" },
          { title = "5xx by service", filter = "resource.type=\"cloud_run_revision\" metric.type=\"run.googleapis.com/request_count\" metric.label.response_code_class=\"5xx\"", group = "resource.label.service_name", aligner = "ALIGN_SUM" },
          { title = "429 by service", filter = "resource.type=\"cloud_run_revision\" metric.type=\"run.googleapis.com/request_count\" metric.label.response_code=\"429\"", group = "resource.label.service_name", aligner = "ALIGN_SUM" },
          { title = "p95 latency by service (ms)", filter = "resource.type=\"cloud_run_revision\" metric.type=\"run.googleapis.com/request_latencies\"", group = "resource.label.service_name", aligner = "ALIGN_PERCENTILE_95" },
          { title = "Job executions: succeeded", filter = "resource.type=\"cloud_run_job\" metric.type=\"run.googleapis.com/job/completed_execution_count\" metric.label.result=\"succeeded\"", group = "resource.label.job_name", aligner = "ALIGN_SUM" },
          { title = "Job executions: failed", filter = "resource.type=\"cloud_run_job\" metric.type=\"run.googleapis.com/job/completed_execution_count\" metric.label.result=\"failed\"", group = "resource.label.job_name", aligner = "ALIGN_SUM" },
          { title = "Pub/Sub undelivered (push backlog)", filter = "resource.type=\"pubsub_subscription\" metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\"", group = "resource.label.subscription_id", aligner = "ALIGN_MAX" },
          { title = "Instances by service", filter = "resource.type=\"cloud_run_revision\" metric.type=\"run.googleapis.com/container/instance_count\"", group = "resource.label.service_name", aligner = "ALIGN_MAX" },
          ] : {
          xPos   = (i % 2) * 6
          yPos   = floor(i / 2) * 4
          width  = 6
          height = 4
          widget = {
            title = t.title
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = t.filter
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = t.aligner
                      crossSeriesReducer = t.aligner == "ALIGN_PERCENTILE_95" ? "REDUCE_MAX" : "REDUCE_SUM"
                      groupByFields      = [t.group]
                    }
                  }
                }
              }]
            }
          }
        }
      ]
    }
  })
  depends_on = [google_project_service.required]
}
