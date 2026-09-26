-- Hotspot Confidence Model features -- ONE definition for training AND
-- hourly scoring (no train/serve skew). Applied by `vayusetu_ingest migrate`.
--
--   SELECT * FROM core.hotspot_features(start_ts, end_ts, cells)
--   cells = [] -> every res-8 cell of every corridor (scoring)
--   cells = [..] -> just these cells (training: official-monitor cells)
--
-- As-of rules (every value must already exist at scoring time):
--   satellite  : day D-1 (daily products; D-2 fallback)
--   weather    : the same hour (Weather API live, ERA5 in history -- same variables)
--   monitors   : daily means for D-2 (the OpenAQ copy of CPCB lags ~2 days)
--   citizens   : qualifying reports in the cell over the last 3 hours
-- Boundary-layer height is deliberately NOT a feature: ERA5 lags ~5 days and
-- the Weather API has no BLH, so it would be missing at scoring time.
CREATE OR REPLACE TABLE FUNCTION `core.hotspot_features`(start_ts TIMESTAMP, end_ts TIMESTAMP, only_cells ARRAY<STRING>) AS (
  WITH hours AS (
    SELECT ts
    FROM UNNEST(GENERATE_TIMESTAMP_ARRAY(TIMESTAMP_TRUNC(start_ts, HOUR), TIMESTAMP_SUB(end_ts, INTERVAL 1 HOUR), INTERVAL 1 HOUR)) AS ts
  ),
  cells AS (
    SELECT h3_index, corridor_id, h3_res4, nearest_station_id, nearest_station_distance_km, has_monitor_within_radius
    FROM `core.h3_cells`
    WHERE ARRAY_LENGTH(only_cells) = 0 OR h3_index IN UNNEST(only_cells)
  ),
  station_daily AS (
    SELECT g.station_id, s.corridor_id, g.observation_date AS d, AVG(g.aqi) AS aqi
    FROM `core.ground_truth_aqi` g
    JOIN `core.monitoring_stations` s USING (station_id)
    WHERE g.aqi IS NOT NULL
      AND g.observation_date BETWEEN DATE_SUB(DATE(start_ts), INTERVAL 3 DAY) AND DATE(end_ts)
    GROUP BY 1, 2, 3
  ),
  regional_daily AS (
    SELECT corridor_id, d, AVG(aqi) AS aqi, COUNT(*) AS stations
    FROM station_daily
    GROUP BY 1, 2
  ),
  sat AS (
    SELECT h3_index, observation_date AS d, no2_column_mol_m2, aerosol_index, aod_550nm, fire_detection_count, burn_scar_fraction
    FROM `core.satellite_features`
    WHERE observation_date BETWEEN DATE_SUB(DATE(start_ts), INTERVAL 3 DAY) AND DATE(end_ts)
  ),
  met AS (
    SELECT h3_index, TIMESTAMP_ADD(TIMESTAMP(observation_date), INTERVAL observation_hour HOUR) AS ts,
           wind_speed_ms, wind_direction_deg, temperature_c, relative_humidity_pct, precipitation_mm
    FROM `core.meteorology_features`
    WHERE observation_date BETWEEN DATE(start_ts) AND DATE(end_ts)
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY h3_index, observation_date, observation_hour
      ORDER BY IF(source = 'GOOGLE_WEATHER_API', 0, 1)
    ) = 1
  ),
  citizen AS (
    SELECT h3_index, TIMESTAMP_ADD(TIMESTAMP(observation_date), INTERVAL observation_hour HOUR) AS ts, report_count, avg_severity
    FROM `core.citizen_reports_agg`
    WHERE observation_date BETWEEN DATE_SUB(DATE(start_ts), INTERVAL 1 DAY) AND DATE(end_ts)
  ),
  grid AS (
    SELECT c.*, h.ts, DATE(h.ts) AS d FROM cells c CROSS JOIN hours h
  )
  SELECT
    g.h3_index,
    g.corridor_id,
    g.ts,
    g.has_monitor_within_radius,
    g.nearest_station_distance_km,
    -- satellite (D-1, else D-2)
    COALESCE(s1.no2_column_mol_m2, s2.no2_column_mol_m2) AS sat_no2,
    COALESCE(s1.aerosol_index, s2.aerosol_index) AS sat_aerosol_index,
    COALESCE(s1.aod_550nm, s2.aod_550nm) AS sat_aod,
    COALESCE(s1.fire_detection_count, s2.fire_detection_count, 0) AS sat_fire_count,
    COALESCE(s1.burn_scar_fraction, s2.burn_scar_fraction) AS sat_burn_scar,
    -- weather (same hour)
    m.wind_speed_ms,
    SIN(m.wind_direction_deg * ACOS(-1) / 180) AS wind_dir_sin,
    COS(m.wind_direction_deg * ACOS(-1) / 180) AS wind_dir_cos,
    m.temperature_c,
    m.relative_humidity_pct,
    m.precipitation_mm,
    -- citizens (last 3 h)
    COALESCE(ci.reports, 0) AS citizen_report_count_3h,
    ci.avg_severity AS citizen_avg_severity_3h,
    -- monitors (D-2)
    ns.aqi AS nearest_station_aqi_d2,
    r.aqi AS regional_aqi_d2,
    r.stations AS regional_station_count_d2,
    -- calendar (IST)
    EXTRACT(HOUR FROM DATETIME(g.ts, 'Asia/Kolkata')) AS hour_ist,
    EXTRACT(DAYOFWEEK FROM DATETIME(g.ts, 'Asia/Kolkata')) AS day_of_week,
    EXTRACT(MONTH FROM DATETIME(g.ts, 'Asia/Kolkata')) AS month,
    `core.is_harvest_season`(DATE(g.ts, 'Asia/Kolkata')) AS is_harvest_season,
    `core.is_diwali_window`(DATE(g.ts, 'Asia/Kolkata')) AS is_diwali_window
  FROM grid g
  LEFT JOIN sat s1 ON s1.h3_index = g.h3_index AND s1.d = DATE_SUB(g.d, INTERVAL 1 DAY)
  LEFT JOIN sat s2 ON s2.h3_index = g.h3_index AND s2.d = DATE_SUB(g.d, INTERVAL 2 DAY)
  LEFT JOIN met m ON m.h3_index = g.h3_res4 AND m.ts = g.ts
  LEFT JOIN (
    SELECT g2.h3_index, g2.ts, SUM(c.report_count) AS reports,
           SAFE_DIVIDE(SUM(c.avg_severity * c.report_count), SUM(c.report_count)) AS avg_severity
    FROM grid g2
    JOIN citizen c ON c.h3_index = g2.h3_index AND c.ts BETWEEN TIMESTAMP_SUB(g2.ts, INTERVAL 2 HOUR) AND g2.ts
    GROUP BY 1, 2
  ) ci ON ci.h3_index = g.h3_index AND ci.ts = g.ts
  LEFT JOIN station_daily ns ON ns.station_id = g.nearest_station_id AND ns.d = DATE_SUB(g.d, INTERVAL 2 DAY)
  LEFT JOIN regional_daily r ON r.corridor_id = g.corridor_id AND r.d = DATE_SUB(g.d, INTERVAL 2 DAY)
);
