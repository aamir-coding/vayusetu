-- Hourly Hotspot Fusion Engine output: EVERY scored res-8 cell (Firestore
-- `hotspots` only holds the top cells the heatmap shows). Mirrors
-- API_CONTRACTS.md HotspotCell; written by hotspot-service's hourly job.
CREATE TABLE IF NOT EXISTS `core.hotspot_cells` (
  id STRING NOT NULL,                  -- `${h3Index}_${YYYY-MM-DDTHH}`
  h3_index STRING NOT NULL,
  corridor_id STRING NOT NULL,
  timestamp_hour TIMESTAMP NOT NULL,
  hotspot_confidence_score FLOAT64 NOT NULL,
  model_score FLOAT64,                 -- model probability before citizen-evidence fusion
  citizen_score FLOAT64,               -- citizen-evidence probability (0 when no reports)
  is_hidden BOOL NOT NULL,
  classification STRING NOT NULL,
  citizen_report_count INT64,
  avg_citizen_severity FLOAT64,
  satellite_aod FLOAT64,
  satellite_no2 FLOAT64,
  fire_detection_count INT64,
  nearest_monitor_id STRING,
  nearest_monitor_delta_aqi FLOAT64,
  model_version STRING NOT NULL,
  created_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(timestamp_hour)
CLUSTER BY corridor_id, h3_index;
