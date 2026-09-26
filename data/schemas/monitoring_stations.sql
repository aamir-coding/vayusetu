-- Official monitor registry (API_CONTRACTS.md MonitoringStation), built from
-- the CPCB feed by the `cpcb` job and mirrored to Firestore monitoringStations.
CREATE TABLE IF NOT EXISTS `core.monitoring_stations` (
  station_id STRING NOT NULL,          -- slug of the CPCB station name, e.g. 'anand-vihar-delhi-dpcc'
  name STRING NOT NULL,
  agency STRING NOT NULL,              -- CPCB | SPCB | other
  city STRING,
  state STRING,
  corridor_id STRING,
  lat FLOAT64 NOT NULL,
  lng FLOAT64 NOT NULL,
  h3_index STRING NOT NULL,            -- res 8
  is_official BOOL NOT NULL,
  last_reading_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL
)
CLUSTER BY corridor_id;
