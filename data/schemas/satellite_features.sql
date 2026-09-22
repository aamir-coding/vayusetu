CREATE TABLE IF NOT EXISTS `core.satellite_features` (
  h3_index STRING NOT NULL,
  corridor_id STRING,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  no2_column_mol_m2 FLOAT64,
  aerosol_index FLOAT64,
  aod_550nm FLOAT64,
  fire_detection_count INT64,
  fire_frp_sum FLOAT64,
  source_dataset STRING NOT NULL,      -- e.g. 'COPERNICUS/S5P/NRTI/L3_NO2'
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY observation_date
CLUSTER BY h3_index, corridor_id;