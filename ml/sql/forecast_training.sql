-- AQI Forecast Model training set (AutoML Forecasting, one series per
-- official monitor, hourly; forecast-service averages station forecasts into
-- the corridor's 24/48/72 h horizons).
--
-- Target: station NAQI (hourly, from CPCB via OpenAQ / data.gov.in).
-- Covariates:
--   AVAILABLE at forecast time -- calendar (hour, weekday, harvest window,
--     Diwali window) + weather (wind, temperature, humidity, rain). History
--     uses observed weather (Weather API / ERA5); forecasting uses the Weather
--     API 72 h forecast ("perfect prognosis", standard in AQ forecasting).
--   UNAVAILABLE at forecast time (history only) -- boundary-layer height
--     (ERA5), corridor fire count and mean AOD (Earth Engine).
-- Split: by TIME, same rule as the hotspot set.
--
-- Params: @start_ts, @end_ts, @validate_from, @test_from (TIMESTAMP)
-- Derived table, rebuilt from scratch every run and owned here (not by
-- data/schemas): DROP first so a partitioning/clustering change can never
-- block a rebuild ("Cannot replace a table with a different partitioning spec").
DROP TABLE IF EXISTS `{dataset}.forecast_training_dataset`;

CREATE OR REPLACE TABLE `{dataset}.forecast_training_dataset`
PARTITION BY DATE(ts)
CLUSTER BY corridor_id AS
WITH station_hourly AS (
  SELECT g.station_id, s.corridor_id, s.h3_index,
         TIMESTAMP_ADD(TIMESTAMP(g.observation_date), INTERVAL g.observation_hour HOUR) AS ts,
         AVG(g.aqi) AS aqi
  FROM `{dataset}.ground_truth_aqi` g
  JOIN `{dataset}.monitoring_stations` s USING (station_id)
  WHERE s.is_official AND g.aqi IS NOT NULL
    AND g.observation_date BETWEEN DATE(@start_ts) AND DATE(@end_ts)
  GROUP BY 1, 2, 3, 4
),
met AS (
  SELECT h3_index AS h3_res4,
         TIMESTAMP_ADD(TIMESTAMP(observation_date), INTERVAL observation_hour HOUR) AS ts,
         wind_speed_ms, wind_direction_deg, temperature_c, relative_humidity_pct, precipitation_mm,
         boundary_layer_height_m
  FROM `{dataset}.meteorology_features`
  WHERE observation_date BETWEEN DATE(@start_ts) AND DATE(@end_ts)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY h3_index, observation_date, observation_hour
    ORDER BY IF(source = 'ERA5', 0, 1)   -- ERA5 carries boundary-layer height
  ) = 1
),
-- Satellite rows are res-7 values fanned out to res-8 children: aggregate over
-- DISTINCT res-7 cells or every fire is counted ~7 times.
sat_daily AS (
  SELECT corridor_id, d, SUM(fire) AS fire_count, AVG(aod) AS mean_aod
  FROM (
    SELECT DISTINCT c.h3_res7, s.corridor_id, s.observation_date AS d,
           s.fire_detection_count AS fire, s.aod_550nm AS aod
    FROM `{dataset}.satellite_features` s
    JOIN `{dataset}.h3_cells` c USING (h3_index)
    WHERE s.observation_date BETWEEN DATE_SUB(DATE(@start_ts), INTERVAL 1 DAY) AND DATE(@end_ts)
  )
  GROUP BY 1, 2
)
SELECT
  sh.station_id,
  sh.corridor_id,
  sh.ts,
  sh.aqi,
  -- available at forecast
  m.wind_speed_ms,
  SIN(m.wind_direction_deg * ACOS(-1) / 180) AS wind_dir_sin,
  COS(m.wind_direction_deg * ACOS(-1) / 180) AS wind_dir_cos,
  m.temperature_c,
  m.relative_humidity_pct,
  m.precipitation_mm,
  EXTRACT(HOUR FROM DATETIME(sh.ts, 'Asia/Kolkata')) AS hour_ist,
  EXTRACT(DAYOFWEEK FROM DATETIME(sh.ts, 'Asia/Kolkata')) AS day_of_week,
  `{dataset}.is_harvest_season`(DATE(sh.ts, 'Asia/Kolkata')) AS is_harvest_season,
  `{dataset}.is_diwali_window`(DATE(sh.ts, 'Asia/Kolkata')) AS is_diwali_window,
  -- unavailable at forecast (history only)
  m.boundary_layer_height_m,
  sd.fire_count AS corridor_fire_count_d1,
  sd.mean_aod AS corridor_mean_aod_d1,
  CASE
    WHEN sh.ts >= @test_from THEN 'TEST'
    WHEN sh.ts >= @validate_from THEN 'VALIDATE'
    ELSE 'TRAIN'
  END AS split
FROM station_hourly sh
JOIN `{dataset}.h3_cells` c ON c.h3_index = sh.h3_index
LEFT JOIN met m ON m.h3_res4 = c.h3_res4 AND m.ts = sh.ts
LEFT JOIN sat_daily sd ON sd.corridor_id = sh.corridor_id AND sd.d = DATE_SUB(DATE(sh.ts), INTERVAL 1 DAY)
