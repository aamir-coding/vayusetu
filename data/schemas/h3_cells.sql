-- Reference grid: every operational (res-8) cell of every corridor, with the
-- parent cells other tables are keyed at and the distance to the nearest
-- OFFICIAL monitor. BigQuery has no H3, so all H3 arithmetic happens in
-- ingestion-jobs (`seed` job) and feature joins go through this table.
-- Rewritten in full by `python -m vayusetu_ingest seed`.
CREATE TABLE IF NOT EXISTS `core.h3_cells` (
  h3_index STRING NOT NULL,            -- res 8 (operational grid)
  corridor_id STRING NOT NULL,
  lat FLOAT64 NOT NULL,                -- cell centroid
  lng FLOAT64 NOT NULL,
  h3_res7 STRING NOT NULL,             -- Earth Engine sampling cell
  h3_res6 STRING NOT NULL,             -- federated (k-anonymized) cell
  h3_res4 STRING NOT NULL,             -- weather grid cell
  nearest_station_id STRING,
  nearest_station_distance_km FLOAT64,
  has_monitor_within_radius BOOL NOT NULL, -- official monitor within 3 km (hidden-hotspot definition)
  updated_at TIMESTAMP NOT NULL
)
CLUSTER BY corridor_id, h3_index;
