-- Distinct reporting users per cell-hour: federation-service's k-anonymity
-- publishes a cell only with >= k DISTINCT contributors.
ALTER TABLE `core.citizen_reports_agg` ADD COLUMN IF NOT EXISTS contributor_count INT64;
