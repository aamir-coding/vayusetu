CREATE TABLE IF NOT EXISTS `core.hotspot_training_dataset` (
  h3_index STRING NOT NULL,
  corridor_id STRING NOT NULL,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  no2_column_mol_m2 FLOAT64,
  aerosol_index FLOAT64,
  fire_detection_count INT64,
  wind_speed_ms FLOAT64,
  boundary_layer_height_m FLOAT64,
  citizen_report_count INT64,
  citizen_avg_severity FLOAT64,
  nearest_monitor_distance_km FLOAT64,
  nearest_monitor_aqi FLOAT64,
  is_hidden_hotspot BOOL,
  actual_aqi_deviation FLOAT64,
  dataset_split STRING                 -- 'train' | 'validation' | 'test'
)
PARTITION BY observation_date
CLUSTER BY corridor_id, h3_index;