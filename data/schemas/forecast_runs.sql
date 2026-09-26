-- 72-hour forecast runs (API_CONTRACTS.md ForecastRun, one row per horizon
-- point) written by forecast-service; Firestore `forecasts` holds the same
-- runs for the dashboard.
CREATE TABLE IF NOT EXISTS `core.forecast_runs` (
  id STRING NOT NULL,                  -- `${corridorId}_${forecastRunTimestamp}`
  corridor_id STRING NOT NULL,
  forecast_run_timestamp TIMESTAMP NOT NULL,
  horizon_hours INT64 NOT NULL,        -- 24 | 48 | 72
  predicted_aqi FLOAT64 NOT NULL,
  predicted_aqi_category STRING NOT NULL,
  predicted_grap_stage STRING NOT NULL,
  ci_lower FLOAT64,
  ci_upper FLOAT64,
  key_drivers ARRAY<STRING>,
  model_version STRING NOT NULL,
  created_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(forecast_run_timestamp)
CLUSTER BY corridor_id;
