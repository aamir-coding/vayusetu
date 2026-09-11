-- ml/hotspot-model/feature_query.sql
--
-- DRAFT -- Week 1, Engineer 3 (TEAM_ROLES_AND_REPO_MAP.md: "Draft BigQuery
-- feature-extraction SQL for hotspot_training_dataset").
--
-- Populates the FEATURE columns of `vayusetu.core.hotspot_training_dataset`
-- (DB_SCHEMA.md) by joining satellite_features, meteorology_features, and
-- citizen_reports_agg on (h3_index [, corridor_id], observation_date,
-- observation_hour). Label columns (is_hidden_hotspot, actual_aqi_deviation,
-- dataset_split) are intentionally left NULL here -- see note at the bottom.
--
-- ---------------------------------------------------------------------
-- OPEN DEPENDENCY -- flag to Engineer 4 (DB_SCHEMA.md steward for BigQuery)
-- before Week 2:
--
-- nearest_monitor_distance_km / nearest_monitor_aqi require knowing each
-- monitoring station's lat/lng relative to a given H3 cell. Today, station
-- lat/lng lives only in the Firestore `monitoringStations` collection
-- (DB_SCHEMA.md), not in BigQuery -- and BigQuery has no native H3 support
-- (DB_SCHEMA.md, "H3 Spatial Indexing": H3 is computed at the application
-- layer via h3-js / h3, not in SQL). So this can't be a pure BigQuery join
-- without one of:
--   (a) a small synced reference table, e.g.
--       `vayusetu.core.nearest_monitor_lookup(h3_index, nearest_monitor_id,
--       distance_km)`, precomputed at the application layer (hotspot-service
--       already depends on h3-js via packages/h3-utils) and refreshed on the
--       same cadence as citizenReportsRollup.ts, or
--   (b) enabling the community Carto Analytics Toolbox for BigQuery
--       (mentioned in DB_SCHEMA.md as an optional Phase 2 convenience) for
--       native H3-to-centroid conversion, then computing distance with
--       ST_DISTANCE in SQL directly.
-- This draft assumes (a), since it needs no new GCP dependency and reuses
-- code Engineer 3 already owns. Until that table exists, this query still
-- runs -- the two columns just come back NULL via the LEFT JOIN.
-- ---------------------------------------------------------------------

DECLARE start_date DATE DEFAULT DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY);
DECLARE end_date DATE DEFAULT CURRENT_DATE();

WITH satellite_agg AS (
  SELECT
    h3_index,
    corridor_id,
    observation_date,
    observation_hour,
    AVG(no2_column_mol_m2) AS no2_column_mol_m2,
    AVG(aerosol_index)     AS aerosol_index,
    SUM(fire_detection_count) AS fire_detection_count
  FROM `vayusetu.core.satellite_features`
  WHERE observation_date BETWEEN start_date AND end_date
  GROUP BY h3_index, corridor_id, observation_date, observation_hour
),

met_agg AS (
  SELECT
    h3_index,
    observation_date,
    observation_hour,
    AVG(wind_speed_ms)             AS wind_speed_ms,
    AVG(boundary_layer_height_m)   AS boundary_layer_height_m
  FROM `vayusetu.core.meteorology_features`
  WHERE observation_date BETWEEN start_date AND end_date
  GROUP BY h3_index, observation_date, observation_hour
),

citizen_agg AS (
  SELECT
    h3_index,
    corridor_id,
    observation_date,
    observation_hour,
    report_count  AS citizen_report_count,
    avg_severity  AS citizen_avg_severity
  FROM `vayusetu.core.citizen_reports_agg`
  WHERE observation_date BETWEEN start_date AND end_date
),

-- See OPEN DEPENDENCY note above. Referencing this table now so the shape
-- of the final SELECT is right; it's fine if the table doesn't exist yet --
-- the LEFT JOIN just yields NULLs, it won't break the query.
nearest_monitor AS (
  SELECT h3_index, nearest_monitor_id, distance_km AS nearest_monitor_distance_km
  FROM `vayusetu.core.nearest_monitor_lookup`
),

ground_truth_at_monitor AS (
  SELECT
    station_id,
    observation_date,
    observation_hour,
    AVG(aqi) AS aqi
  FROM `vayusetu.core.ground_truth_aqi`
  WHERE observation_date BETWEEN start_date AND end_date
  GROUP BY station_id, observation_date, observation_hour
)

SELECT
  s.h3_index,
  s.corridor_id,
  s.observation_date,
  s.observation_hour,
  s.no2_column_mol_m2,
  s.aerosol_index,
  s.fire_detection_count,
  m.wind_speed_ms,
  m.boundary_layer_height_m,
  COALESCE(c.citizen_report_count, 0) AS citizen_report_count,
  c.citizen_avg_severity,
  nm.nearest_monitor_distance_km,
  gt.aqi AS nearest_monitor_aqi,

  -- Labels: deliberately NULL in this Week 1 *feature-extraction* draft.
  -- DB_SCHEMA.md's own comment on this table says these are "computed
  -- retrospectively once ground truth is available" -- that's a separate
  -- backfill/labeling job, planned for Week 3 per
  -- TEAM_ROLES_AND_REPO_MAP.md ("Hotspot model retrained on the fuller
  -- dataset"). Don't back-fill a guessed definition here; get the label
  -- methodology reviewed first.
  CAST(NULL AS BOOL)    AS is_hidden_hotspot,
  CAST(NULL AS FLOAT64) AS actual_aqi_deviation,
  CAST(NULL AS STRING)  AS dataset_split

FROM satellite_agg s
LEFT JOIN met_agg m
  ON  s.h3_index = m.h3_index
  AND s.observation_date = m.observation_date
  AND s.observation_hour = m.observation_hour
LEFT JOIN citizen_agg c
  ON  s.h3_index = c.h3_index
  AND s.corridor_id = c.corridor_id
  AND s.observation_date = c.observation_date
  AND s.observation_hour = c.observation_hour
LEFT JOIN nearest_monitor nm
  ON s.h3_index = nm.h3_index
LEFT JOIN ground_truth_at_monitor gt
  ON  nm.nearest_monitor_id = gt.station_id
  AND s.observation_date = gt.observation_date
  AND s.observation_hour = gt.observation_hour
;

-- To materialize into the actual table instead of just previewing rows,
-- wrap the SELECT above as:
--   INSERT INTO `vayusetu.core.hotspot_training_dataset` (<same column list>)
--   SELECT ...
-- or run it as a scheduled query once nearest_monitor_lookup exists.
