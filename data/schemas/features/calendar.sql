-- Calendar covariates shared by both models (PRODUCT_SPEC Feature 3 inputs:
-- "seasonal-burning calendar (Punjab/Haryana harvest windows)" and
-- "festival/traffic calendar (Diwali)"). Dates are IST calendar dates.
-- Named in data/schemas/features so `migrate` applies them after the tables.

-- Kharif paddy-stubble burning (Oct 1 - Nov 30) and rabi wheat-residue
-- burning (Apr 10 - May 15) in Punjab/Haryana.
CREATE OR REPLACE FUNCTION `core.is_harvest_season`(d DATE) AS (
  (EXTRACT(MONTH FROM d) IN (10, 11))
  OR (EXTRACT(MONTH FROM d) = 4 AND EXTRACT(DAY FROM d) >= 10)
  OR (EXTRACT(MONTH FROM d) = 5 AND EXTRACT(DAY FROM d) <= 15)
);

-- Diwali (Lakshmi Puja) dates; the window is 5 days either side, which covers
-- the pre-festival build-up and the post-firecracker PM2.5 spike. Extend the
-- list each year.
CREATE OR REPLACE FUNCTION `core.is_diwali_window`(d DATE) AS (
  EXISTS (
    SELECT 1
    FROM UNNEST([DATE '2023-11-12', DATE '2024-11-01', DATE '2025-10-21', DATE '2026-11-08', DATE '2027-10-29', DATE '2028-10-17']) AS diwali
    WHERE ABS(DATE_DIFF(d, diwali, DAY)) <= 5
  )
);
