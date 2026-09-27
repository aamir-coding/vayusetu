-- One row per retrain evaluation (promoted or not), written by the Vertex AI
-- Pipelines evaluate_and_promote step. Source for the model cards / Week-4
-- evaluation write-up.
CREATE TABLE IF NOT EXISTS `core.model_evaluations` (
  model_type STRING NOT NULL,          -- hotspot | forecast
  model_version STRING NOT NULL,       -- versioned registry resource name
  metric STRING NOT NULL,              -- gate metric (auPrc | meanAbsolutePercentageError)
  value FLOAT64,
  previous_default_value FLOAT64,
  decision STRING NOT NULL,            -- promoted | rejected
  all_metrics STRING,                  -- JSON of every numeric metric Vertex reported
  training_rows INT64,
  training_positives INT64,
  evaluated_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(evaluated_at);
