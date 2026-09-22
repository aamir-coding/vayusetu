CREATE TABLE IF NOT EXISTS `core.meteorology_features` (
  h3_index STRING NOT NULL,
  station_id STRING,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  wind_speed_ms FLOAT64,
  wind_direction_deg FLOAT64,
  temperature_c FLOAT64,
  relative_humidity_pct FLOAT64,
  boundary_layer_height_m FLOAT64,
  precipitation_mm FLOAT64,
  source STRING NOT NULL,              -- 'IMD'
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY observation_date
CLUSTER BY h3_index;