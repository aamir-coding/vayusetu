-- AQI Forecast Model scoring input (AutoML Forecasting batch prediction), in
-- the SAME daily IST steps the model was trained on:
--   CONTEXT  = 14 days D-13 .. D (D = run_ts's IST date; today is partial)
--   HORIZON  = D+1 .. D+3, target NULL = "predict this" (+24/+48/+72 h).
-- Each row's ts is that day's IST midnight, so forecast-service's
-- [t0+h-24h, t0+h) windows pick up D+1/D+2/D+3 for any run time after
-- midnight IST (the job runs at :45 IST, never on the boundary).
-- Column names match ml/sql/forecast_training.sql exactly.
--
-- Target in the context window: measured station NAQI (CPCB via data.gov.in
-- live, or the ~2-day-late OpenAQ copy); days not yet measured are filled
-- with the Google Air Quality API's MODELED AQI at the station site.
-- `target_source` records which it was.
-- Horizon weather: the latest Google Weather API forecast issued <= run_ts.
CREATE OR REPLACE TABLE FUNCTION `core.forecast_input`(run_ts TIMESTAMP, corridor STRING) AS (
  WITH origin AS (SELECT DATE(run_ts, 'Asia/Kolkata') AS d0),
  stations AS (
    SELECT s.station_id, s.corridor_id, c.h3_res4
    FROM `core.monitoring_stations` s
    JOIN `core.h3_cells` c ON c.h3_index = s.h3_index
    WHERE s.is_official AND s.corridor_id = corridor
  ),
  steps AS (
    SELECT d, TIMESTAMP(d, 'Asia/Kolkata') AS ts, d > d0 AS is_horizon
    FROM origin, UNNEST(GENERATE_DATE_ARRAY(DATE_SUB(d0, INTERVAL 13 DAY), DATE_ADD(d0, INTERVAL 3 DAY))) AS d
  ),
  measured AS (
    SELECT station_id, TIMESTAMP(DATE(TIMESTAMP_ADD(TIMESTAMP(observation_date), INTERVAL observation_hour HOUR), 'Asia/Kolkata'), 'Asia/Kolkata') AS ts, AVG(aqi) AS aqi
    FROM `core.ground_truth_aqi`, origin
    WHERE aqi IS NOT NULL AND observation_date BETWEEN DATE_SUB(d0, INTERVAL 15 DAY) AND DATE_ADD(d0, INTERVAL 1 DAY)
    GROUP BY 1, 2
  ),
  modeled AS (
    SELECT station_id, TIMESTAMP(DATE(TIMESTAMP_ADD(TIMESTAMP(observation_date), INTERVAL observation_hour HOUR), 'Asia/Kolkata'), 'Asia/Kolkata') AS ts, AVG(aqi) AS aqi
    FROM `core.modeled_aqi`, origin
    WHERE station_id IS NOT NULL AND aqi IS NOT NULL AND observation_date BETWEEN DATE_SUB(d0, INTERVAL 15 DAY) AND DATE_ADD(d0, INTERVAL 1 DAY)
    GROUP BY 1, 2
  ),
  observed_met AS (
    SELECT h3_res4, TIMESTAMP(DATE(ts, 'Asia/Kolkata'), 'Asia/Kolkata') AS ts,
           AVG(wind_speed_ms) AS wind_speed_ms,
           AVG(SIN(wind_direction_deg * ACOS(-1) / 180)) AS wind_dir_sin,
           AVG(COS(wind_direction_deg * ACOS(-1) / 180)) AS wind_dir_cos,
           AVG(temperature_c) AS temperature_c, AVG(relative_humidity_pct) AS relative_humidity_pct,
           SUM(precipitation_mm) AS precipitation_mm, AVG(boundary_layer_height_m) AS boundary_layer_height_m
    FROM (
      SELECT h3_index AS h3_res4, TIMESTAMP_ADD(TIMESTAMP(observation_date), INTERVAL observation_hour HOUR) AS ts,
             wind_speed_ms, wind_direction_deg, temperature_c, relative_humidity_pct, precipitation_mm, boundary_layer_height_m
      FROM `core.meteorology_features`, origin
      WHERE observation_date BETWEEN DATE_SUB(d0, INTERVAL 15 DAY) AND DATE_ADD(d0, INTERVAL 1 DAY)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY h3_index, observation_date, observation_hour ORDER BY IF(source = 'ERA5', 0, 1)) = 1
    )
    GROUP BY 1, 2
  ),
  forecast_met AS (
    SELECT h3_res4, TIMESTAMP(DATE(ts, 'Asia/Kolkata'), 'Asia/Kolkata') AS ts,
           AVG(wind_speed_ms) AS wind_speed_ms,
           AVG(SIN(wind_direction_deg * ACOS(-1) / 180)) AS wind_dir_sin,
           AVG(COS(wind_direction_deg * ACOS(-1) / 180)) AS wind_dir_cos,
           AVG(temperature_c) AS temperature_c, AVG(relative_humidity_pct) AS relative_humidity_pct,
           SUM(precipitation_mm) AS precipitation_mm
    FROM (
      SELECT h3_index AS h3_res4, target_ts AS ts,
             wind_speed_ms, wind_direction_deg, temperature_c, relative_humidity_pct, precipitation_mm
      FROM `core.meteorology_forecast`, origin
      WHERE issued_at <= run_ts
        AND DATE(target_ts, 'Asia/Kolkata') BETWEEN DATE_ADD(d0, INTERVAL 1 DAY) AND DATE_ADD(d0, INTERVAL 3 DAY)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY h3_index, target_ts ORDER BY issued_at DESC) = 1
    )
    GROUP BY 1, 2
  ),
  sat_daily AS (
    SELECT corridor_id, d, SUM(fire) AS fire_count, AVG(aod) AS mean_aod
    FROM (
      SELECT DISTINCT c.h3_res7, s.corridor_id, s.observation_date AS d, s.fire_detection_count AS fire, s.aod_550nm AS aod
      FROM `core.satellite_features` s
      JOIN `core.h3_cells` c USING (h3_index), origin
      WHERE s.corridor_id = corridor AND s.observation_date BETWEEN DATE_SUB(d0, INTERVAL 15 DAY) AND d0
    )
    GROUP BY 1, 2
  )
  SELECT
    st.station_id,
    st.corridor_id,
    h.ts,
    h.is_horizon,
    IF(h.is_horizon, NULL, COALESCE(me.aqi, mo.aqi)) AS aqi,
    CASE WHEN h.is_horizon THEN 'horizon' WHEN me.aqi IS NOT NULL THEN 'measured' WHEN mo.aqi IS NOT NULL THEN 'modeled' END AS target_source,
    COALESCE(om.wind_speed_ms, fm.wind_speed_ms) AS wind_speed_ms,
    COALESCE(om.wind_dir_sin, fm.wind_dir_sin) AS wind_dir_sin,
    COALESCE(om.wind_dir_cos, fm.wind_dir_cos) AS wind_dir_cos,
    COALESCE(om.temperature_c, fm.temperature_c) AS temperature_c,
    COALESCE(om.relative_humidity_pct, fm.relative_humidity_pct) AS relative_humidity_pct,
    COALESCE(om.precipitation_mm, fm.precipitation_mm) AS precipitation_mm,
    EXTRACT(DAYOFWEEK FROM DATETIME(h.ts, 'Asia/Kolkata')) AS day_of_week,
    `core.is_harvest_season`(h.d) AS is_harvest_season,
    `core.is_diwali_window`(h.d) AS is_diwali_window,
    IF(h.is_horizon, NULL, om.boundary_layer_height_m) AS boundary_layer_height_m,
    IF(h.is_horizon, NULL, sd.fire_count) AS corridor_fire_count_d1,
    IF(h.is_horizon, NULL, sd.mean_aod) AS corridor_mean_aod_d1
  FROM stations st
  CROSS JOIN steps h
  LEFT JOIN measured me ON me.station_id = st.station_id AND me.ts = h.ts
  LEFT JOIN modeled mo ON mo.station_id = st.station_id AND mo.ts = h.ts
  LEFT JOIN observed_met om ON om.h3_res4 = st.h3_res4 AND om.ts = h.ts AND NOT h.is_horizon
  LEFT JOIN forecast_met fm ON fm.h3_res4 = st.h3_res4 AND fm.ts = h.ts AND h.is_horizon
  LEFT JOIN sat_daily sd ON sd.corridor_id = st.corridor_id AND sd.d = DATE_SUB(h.d, INTERVAL 1 DAY)
);
