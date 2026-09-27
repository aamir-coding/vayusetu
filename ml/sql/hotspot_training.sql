-- Hotspot Confidence Model training set (AutoML Tabular, classification).
--
-- LABEL (retrospective, measured -- DB_SCHEMA.md "computed retrospectively
-- once ground truth is available"): at a cell that HAS an official monitor,
-- an hour is a `hotspot` when that monitor reads AQI >= 201 ("poor" or worse)
-- AND >= 50 above the corridor-wide mean of all monitors that same hour
-- (a local excess, not a region-wide smog day).
-- The model learns satellite/weather/calendar/regional-background -> local
-- excess where monitors exist, and is applied where they don't; `isHidden`
-- is then the spec's literal rule (high confidence AND no monitor in 3 km).
--
-- Features: core.hotspot_features (identical to hourly scoring). Dropped for
-- training: the monitor-proximity columns, which are ~0 at monitor cells and
-- would only teach "distance 0 means monitored".
-- Split: SPATIAL, by res-6 region (~36 km2) of the monitor. The model's job
-- is scoring places WITHOUT a monitor, so TEST/VALIDATE hold out whole
-- regions the model never trains on (~15% / ~15% of regions, stable hash).
-- With place features (lat/lng, land cover), a time-based split would let
-- the model memorize "this station runs hot" and score well without
-- generalizing. History: v1 used week blocks; a chronological tail before
-- that put the whole test set in the monsoon (3.8% vs 19% positives).
--
-- Params: @start_ts, @end_ts (TIMESTAMP); @validate_from/@test_from are
-- accepted for the shared window API but unused here.
-- Derived table, rebuilt from scratch every run and owned here (not by
-- data/schemas): DROP first so a partitioning/clustering change can never
-- block a rebuild ("Cannot replace a table with a different partitioning spec").
DROP TABLE IF EXISTS `{dataset}.hotspot_training_dataset`;

CREATE OR REPLACE TABLE `{dataset}.hotspot_training_dataset`
PARTITION BY DATE(ts)
CLUSTER BY corridor_id AS
WITH station_hourly AS (
  SELECT s.h3_index, s.corridor_id,
         TIMESTAMP_ADD(TIMESTAMP(g.observation_date), INTERVAL g.observation_hour HOUR) AS ts,
         AVG(g.aqi) AS aqi
  FROM `{dataset}.ground_truth_aqi` g
  JOIN `{dataset}.monitoring_stations` s USING (station_id)
  WHERE s.is_official AND g.aqi IS NOT NULL
    AND g.observation_date BETWEEN DATE(@start_ts) AND DATE(@end_ts)
  GROUP BY 1, 2, 3
),
regional_now AS (
  SELECT corridor_id, ts, AVG(aqi) AS aqi, COUNT(*) AS stations
  FROM station_hourly
  GROUP BY 1, 2
  HAVING COUNT(*) >= 5          -- a "regional mean" of 2 monitors is not a background
),
features AS (
  SELECT *
  FROM `{dataset}.hotspot_features`(@start_ts, @end_ts,
    ARRAY(SELECT DISTINCT h3_index FROM `{dataset}.monitoring_stations` WHERE is_official))
)
SELECT
  f.* EXCEPT (has_monitor_within_radius, nearest_station_id, nearest_station_distance_km, nearest_station_aqi_d2, h3_res6),
  sh.aqi AS station_aqi,
  rn.aqi AS regional_aqi_now,
  sh.aqi - rn.aqi AS actual_aqi_deviation,
  IF(sh.aqi >= 201 AND sh.aqi - rn.aqi >= 50, 'hotspot', 'normal') AS is_hotspot,
  CASE
    WHEN MOD(ABS(FARM_FINGERPRINT(f.h3_res6)), 100) < 15 THEN 'TEST'
    WHEN MOD(ABS(FARM_FINGERPRINT(f.h3_res6)), 100) < 30 THEN 'VALIDATE'
    ELSE 'TRAIN'
  END AS split
FROM features f
JOIN station_hourly sh ON sh.h3_index = f.h3_index AND sh.ts = f.ts
JOIN regional_now rn ON rn.corridor_id = f.corridor_id AND rn.ts = f.ts
