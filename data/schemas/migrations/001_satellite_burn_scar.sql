-- Sentinel-2 burn-scar signal (PRODUCT_SPEC Feature 2 lists it; the Week-1 DDL had no column for it).
ALTER TABLE `core.satellite_features` ADD COLUMN IF NOT EXISTS burn_scar_fraction FLOAT64;
