CREATE TABLE IF NOT EXISTS `core.ground_truth_aqi` (
  station_id STRING NOT NULL,          -- CPCB/SPCB station code
  station_name STRING,
  h3_index STRING NOT NULL,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  pollutant_id STRING,                 -- PM2.5 | PM10 | NO2 | SO2 | CO | O3 | NH3 | Pb
  pollutant_min FLOAT64,
  pollutant_max FLOAT64,
  pollutant_avg FLOAT64,               -- CPCB feed values are SUB-INDICES (0-500 scale), not concentrations
  aqi INT64,                           -- station NAQI = max sub-index (>= 3 pollutants incl. PM), same on every pollutant row
  aqi_category STRING,                 -- good|satisfactory|moderate|poor|very_poor|severe
  source STRING NOT NULL,              -- 'CPCB_DATA_GOV_IN'
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY observation_date
CLUSTER BY station_id, h3_index;