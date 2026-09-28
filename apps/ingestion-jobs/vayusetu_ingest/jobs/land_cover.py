"""Google Earth Engine -> core.cell_static_features (static, rerun yearly).

Per corridor, reduced over res-7 H3 cells (same geometry as satellite_features):
  - Dynamic World V1 (Google): mean class probability of built / crops /
    trees / bare over the last 12 months
  - VIIRS DNB monthly night-time radiance, 12-month median
  - WorldPop 100 m population (2020), as people per km2

These describe the PLACE, and exist for every cell -- the Hotspot Confidence
Model learns "places like this run hotter than the corridor" from monitored
cells and applies it where no monitor exists. EE exports to a BigQuery
staging table; one MERGE upserts by res-7 cell (idempotent reruns).
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

from google.cloud import bigquery

from .. import geo
from ..config import Settings
from .earth_engine import _cell_features, _col, _init_ee, _wait

log = logging.getLogger(__name__)

SOURCE = "EE:DYNAMICWORLD_V1+VIIRS_DNB_MONTHLY+WORLDPOP_100M_2020"
EXPORTED = ("built", "crops", "trees", "bare", "night_lights", "population_density")


def window(today: date) -> tuple[date, date]:
    """The last 12 complete months."""
    end = today.replace(day=1)
    start = date(end.year - 1, end.month, 1)
    return start, end


def _image(ee, roi, start: date, end: date):
    s, e = start.isoformat(), end.isoformat()
    dw = (ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1").filterBounds(roi).filterDate(s, e)
          .select(["built", "crops", "trees", "bare"]).mean())
    lights = (ee.ImageCollection("NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG").filterDate(s, e)
              .select("avg_rad").median().rename("night_lights"))
    # WorldPop pixels are people per ~100 m cell -> x100 = people per km2.
    pop = (ee.ImageCollection("WorldPop/GP/100m/pop").filter(ee.Filter.eq("country", "IND"))
           .filter(ee.Filter.eq("year", 2020)).mosaic().multiply(100).rename("population_density"))
    return dw.addBands(lights).addBands(pop)


def merge_sql(settings: Settings, staging: str, start: date, end: date, present: set[str] | None = None) -> str:
    present = set(EXPORTED) if present is None else present
    return f"""
MERGE `{settings.table('cell_static_features')}` T
USING (
  SELECT s.h3_res7, s.corridor_id,
         {_col('built', present)} AS built_frac, {_col('crops', present)} AS crops_frac,
         {_col('trees', present)} AS trees_frac, {_col('bare', present)} AS bare_frac,
         {_col('night_lights', present)} AS night_lights, {_col('population_density', present)} AS population_density,
         DATE '{start.isoformat()}' AS window_start, DATE '{end.isoformat()}' AS window_end,
         '{SOURCE}' AS source_dataset, CURRENT_TIMESTAMP() AS computed_at
  FROM `{staging}` s
) S
ON T.h3_res7 = S.h3_res7
WHEN MATCHED THEN UPDATE SET corridor_id = S.corridor_id, built_frac = S.built_frac, crops_frac = S.crops_frac,
  trees_frac = S.trees_frac, bare_frac = S.bare_frac, night_lights = S.night_lights,
  population_density = S.population_density, window_start = S.window_start, window_end = S.window_end,
  source_dataset = S.source_dataset, computed_at = S.computed_at
WHEN NOT MATCHED THEN INSERT (h3_res7, corridor_id, built_frac, crops_frac, trees_frac, bare_frac, night_lights,
  population_density, window_start, window_end, source_dataset, computed_at)
VALUES (S.h3_res7, S.corridor_id, S.built_frac, S.crops_frac, S.trees_frac, S.bare_frac, S.night_lights,
  S.population_density, S.window_start, S.window_end, S.source_dataset, S.computed_at)
"""


def run(settings: Settings, **_: object) -> None:
    ee = _init_ee(settings.project)
    bq = bigquery.Client(project=settings.project, location=settings.bq_location)
    start, end = window(datetime.now(timezone.utc).date())
    for corridor in geo.load_corridors(settings.corridor_ids):
        cells = _cell_features(ee, corridor)
        roi = cells.geometry().bounds()
        reduced = _image(ee, roi, start, end).reduceRegions(
            collection=cells, reducer=ee.Reducer.mean(), scale=100, tileScale=8)
        rows = reduced.map(lambda f: ee.Feature(None, f.toDictionary(["h3_res7", "corridor_id", *EXPORTED])))
        staging = f"{settings.project}.{settings.dataset}.ee_stg_static_{corridor.id.replace('-', '_')}"
        task = ee.batch.Export.table.toBigQuery(
            collection=rows, description=f"static_{corridor.id}", table=staging, overwrite=True)
        task.start()
        try:
            _wait(task, staging)
            present = {f.name for f in bq.get_table(staging).schema}
            bq.query(merge_sql(settings, staging, start, end, present)).result()
            log.info("land-cover: %s merged (%s .. %s)", corridor.id, start, end)
        finally:
            bq.delete_table(staging, not_found_ok=True)
