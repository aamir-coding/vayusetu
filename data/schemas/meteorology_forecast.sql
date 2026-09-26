-- Google Weather API hourly forecast per weather cell (res 4), used as the
-- forecast model's met_forecast_* covariates.
CREATE TABLE IF NOT EXISTS `core.meteorology_forecast` (
  h3_index STRING NOT NULL,            -- res 4 weather cell
  corridor_id STRING,
  issued_at TIMESTAMP NOT NULL,
  target_ts TIMESTAMP NOT NULL,
  wind_speed_ms FLOAT64,
  wind_direction_deg FLOAT64,
  temperature_c FLOAT64,
  relative_humidity_pct FLOAT64,
  precipitation_mm FLOAT64,
  source STRING NOT NULL,              -- 'GOOGLE_WEATHER_API'
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(target_ts)
CLUSTER BY corridor_id, h3_index;
