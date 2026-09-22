CREATE TABLE IF NOT EXISTS `core.citizen_reports_agg` (
  h3_index STRING NOT NULL,
  corridor_id STRING,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  report_count INT64,
  avg_severity FLOAT64,
  source_classification_mode STRING,   -- most common classification this cell/hour
  avg_confidence_score FLOAT64,
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY observation_date
CLUSTER BY h3_index, corridor_id;