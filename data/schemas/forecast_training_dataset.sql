CREATE TABLE IF NOT EXISTS `core.forecast_training_dataset` (
  corridor_id STRING NOT NULL,
  ts TIMESTAMP NOT NULL,
  aqi_lag_24h FLOAT64,
  aqi_lag_48h FLOAT64,
  aqi_lag_7d_avg FLOAT64,
  met_forecast_wind_speed_ms FLOAT64,
  met_forecast_boundary_layer_height_m FLOAT64,
  is_harvest_season BOOL,
  is_diwali_window BOOL,
  day_of_week INT64,
  aqi_next_24h FLOAT64,                -- forecast label
  aqi_next_48h FLOAT64,                -- forecast label
  aqi_next_72h FLOAT64,                -- forecast label
  dataset_split STRING
)
PARTITION BY DATE(ts)
CLUSTER BY corridor_id;