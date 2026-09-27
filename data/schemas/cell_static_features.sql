-- Static "what kind of place is this" features per res-7 cell, from Google
-- Earth Engine (`python -m vayusetu_ingest land-cover`, rerun yearly):
--   built/crops/trees/bare  Dynamic World V1 class probabilities, 12-month mean
--   night_lights            VIIRS DNB monthly avg radiance, 12-month median (nW/cm2/sr)
--   population_density      WorldPop 100 m (2020), people per km2
-- They exist for EVERY cell (monitored or not), which is what lets the
-- Hotspot Confidence Model generalize to places without a monitor.
CREATE TABLE IF NOT EXISTS `core.cell_static_features` (
  h3_res7 STRING NOT NULL,
  corridor_id STRING NOT NULL,
  built_frac FLOAT64,
  crops_frac FLOAT64,
  trees_frac FLOAT64,
  bare_frac FLOAT64,
  night_lights FLOAT64,
  population_density FLOAT64,
  window_start DATE,
  window_end DATE,
  source_dataset STRING NOT NULL,
  computed_at TIMESTAMP NOT NULL
)
CLUSTER BY corridor_id, h3_res7;
