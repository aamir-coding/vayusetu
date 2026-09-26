-- Google Maps Platform Air Quality API output: MODELED (not measured) hourly
-- AQI at monitor sites and sampled grid cells. Kept apart from
-- ground_truth_aqi so "official monitor" logic never counts a model output
-- as a monitor. Used for 30-day history backfill and hidden-hotspot labels.
CREATE TABLE IF NOT EXISTS `core.modeled_aqi` (
  h3_index STRING NOT NULL,            -- res 8
  corridor_id STRING,
  station_id STRING,                   -- set when the point is a monitor site
  observation_date DATE NOT NULL,      -- UTC
  observation_hour INT64 NOT NULL,     -- UTC
  aqi INT64,                           -- index code 'ind_cpcb' (CPCB NAQI)
  aqi_category STRING,
  dominant_pollutant STRING,
  pm25_ugm3 FLOAT64,
  pm10_ugm3 FLOAT64,
  no2_ugm3 FLOAT64,
  source STRING NOT NULL,              -- 'GOOGLE_AIR_QUALITY_API'
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY observation_date
CLUSTER BY corridor_id, h3_index;
