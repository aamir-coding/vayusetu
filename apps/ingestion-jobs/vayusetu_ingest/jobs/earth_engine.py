"""Google Earth Engine -> core.satellite_features (daily).

Per UTC day and corridor: Sentinel-5P NO2 + absorbing aerosol index, MODIS
MAIAC AOD (550 nm), FIRMS active fires, Sentinel-2 burn scar (dNBR), each
reduced over res-7 H3 cell polygons (~5 km2, finer than S5P pixels). EE
exports straight to a BigQuery staging table; one MERGE then fans each res-7
value out to its res-8 children via core.h3_cells.

Auth is Application Default Credentials only (Cloud Run service account;
`gcloud auth application-default login` locally). The Week-2 job fell back
to interactive ee.Authenticate(), which hangs forever inside Cloud Run.
The project must be registered for Earth Engine (noncommercial tier for the
hackathon -- ARCHITECTURE_OVERVIEW.md licensing note).
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone

import google.auth
import h3
from google.cloud import bigquery

from .. import geo
from ..config import SATELLITE_SAMPLE_RES, Settings

log = logging.getLogger(__name__)

SOURCE = "EE:S5P_NO2+S5P_AER_AI+MCD19A2+FIRMS+S2_dNBR"
EXPORT_TIMEOUT_S = 45 * 60
NRTI_WINDOW_DAYS = 7  # S5P OFFL products lag ~5 days; use NRTI for recent days
DNBR_BURN_THRESHOLD = 0.27  # USGS moderate-severity burn


def _init_ee(project: str):
    import ee

    creds, _ = google.auth.default(scopes=[
        "https://www.googleapis.com/auth/earthengine",
        "https://www.googleapis.com/auth/cloud-platform",
    ])
    ee.Initialize(credentials=creds, project=project)
    return ee


def _cell_features(ee, corridor: geo.Corridor):
    feats = []
    for c in corridor.cells(SATELLITE_SAMPLE_RES):
        ring = [[lng, lat] for lat, lng in h3.cell_to_boundary(c)]
        ring.append(ring[0])
        feats.append(ee.Feature(ee.Geometry.Polygon([ring]), {"h3_res7": c, "corridor_id": corridor.id}))
    return ee.FeatureCollection(feats)


def _image_for_day(ee, day: date, roi):
    start, end = ee.Date(day.isoformat()), ee.Date((day + timedelta(days=1)).isoformat())
    level = "NRTI" if (date.today() - day).days <= NRTI_WINDOW_DAYS else "OFFL"

    def mean_band(coll_id: str, band: str, scale: float = 1.0, s=start, e=end):
        coll = ee.ImageCollection(coll_id).filterBounds(roi).filterDate(s, e).select(band)
        # Empty collections -> fully masked band, so the day still exports (as NULLs).
        return ee.Image(ee.Algorithms.If(coll.size().gt(0), coll.mean().multiply(scale), ee.Image(0).selfMask())).rename(band)

    no2 = mean_band(f"COPERNICUS/S5P/{level}/L3_NO2", "tropospheric_NO2_column_number_density").rename("no2")
    aai = mean_band(f"COPERNICUS/S5P/{level}/L3_AER_AI", "absorbing_aerosol_index").rename("aai")
    aod = mean_band("MODIS/061/MCD19A2_GRANULES", "Optical_Depth_055", 0.001).rename("aod")

    # dNBR: pre-window (-40..-10 d) median NBR minus post-window (-10..+1 d).
    def nbr(s, e):
        coll = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(roi).filterDate(s, e)
                .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30)))
        return ee.Image(ee.Algorithms.If(
            coll.size().gt(0), coll.median().normalizedDifference(["B8", "B12"]), ee.Image(0).selfMask()))

    dnbr = nbr(start.advance(-40, "day"), start.advance(-10, "day")).subtract(nbr(start.advance(-10, "day"), end))
    burn = dnbr.gt(DNBR_BURN_THRESHOLD).rename("burn")

    firms = ee.ImageCollection("FIRMS").filterBounds(roi).filterDate(start, end).select("confidence")
    fire = ee.Image(ee.Algorithms.If(
        firms.size().gt(0), firms.max().gte(50), ee.Image(0))).rename("fire").unmask(0)

    return no2.addBands(aai).addBands(aod).addBands(burn), fire


def _reduce(ee, corridor: geo.Corridor, day: date):
    cells = _cell_features(ee, corridor)
    roi = cells.geometry().bounds()
    means, fire = _image_for_day(ee, day, roi)
    reduced = means.reduceRegions(collection=cells, reducer=ee.Reducer.mean(), scale=1000, tileScale=4)
    reduced = fire.reduceRegions(collection=reduced, reducer=ee.Reducer.sum().setOutputs(["fire_count"]), scale=1000, tileScale=4)
    day_str = day.isoformat()
    return reduced.map(lambda f: ee.Feature(None, f.toDictionary(["h3_res7", "corridor_id", "no2", "aai", "aod", "burn", "fire_count"]))
                       .set("observation_date", day_str))


def _wait(task, what: str) -> None:
    deadline = time.monotonic() + EXPORT_TIMEOUT_S
    while True:
        status = task.status()
        state = status.get("state")
        if state == "COMPLETED":
            return
        if state in {"FAILED", "CANCELLED", "CANCEL_REQUESTED"}:
            raise RuntimeError(f"EE export {what} {state}: {status.get('error_message')}")
        if time.monotonic() > deadline:
            raise TimeoutError(f"EE export {what} still {state} after {EXPORT_TIMEOUT_S}s")
        time.sleep(20)


def merge_sql(settings: Settings, staging: str) -> str:
    return f"""
MERGE `{settings.table('satellite_features')}` T
USING (
  SELECT c.h3_index, s.corridor_id, DATE(s.observation_date) AS observation_date,
         CAST(NULL AS INT64) AS observation_hour,
         s.no2 AS no2_column_mol_m2, s.aai AS aerosol_index, s.aod AS aod_550nm,
         CAST(ROUND(s.fire_count) AS INT64) AS fire_detection_count,
         CAST(NULL AS FLOAT64) AS fire_frp_sum,  -- the EE FIRMS image carries no FRP band
         s.burn AS burn_scar_fraction,
         '{SOURCE}' AS source_dataset, CURRENT_TIMESTAMP() AS ingested_at
  FROM `{staging}` s JOIN `{settings.table('h3_cells')}` c ON c.h3_res7 = s.h3_res7
) S
ON T.h3_index = S.h3_index AND T.observation_date = S.observation_date AND T.source_dataset = S.source_dataset
WHEN MATCHED THEN UPDATE SET no2_column_mol_m2 = S.no2_column_mol_m2, aerosol_index = S.aerosol_index,
  aod_550nm = S.aod_550nm, fire_detection_count = S.fire_detection_count, burn_scar_fraction = S.burn_scar_fraction,
  corridor_id = S.corridor_id, ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT ROW"""


def run(settings: Settings, start: str | None = None, days: int = 1, **_: object) -> None:
    ee = _init_ee(settings.project)
    bq = bigquery.Client(project=settings.project, location=settings.bq_location)
    first = date.fromisoformat(start) if start else (datetime.now(timezone.utc).date() - timedelta(days=1))
    corridors = geo.load_corridors(settings.corridor_ids)
    for offset in range(days):
        day = first + timedelta(days=offset)
        for corridor in corridors:
            staging = f"{settings.project}.{settings.dataset}.ee_stg_{corridor.id.replace('-', '_')}_{day:%Y%m%d}"
            task = ee.batch.Export.table.toBigQuery(
                collection=_reduce(ee, corridor, day),
                description=f"sat_{corridor.id}_{day:%Y%m%d}",
                table=staging,
                overwrite=True,
            )
            task.start()
            _wait(task, staging)
            bq.query(merge_sql(settings, staging)).result()
            bq.delete_table(staging, not_found_ok=True)
            log.info("earth-engine: %s %s merged", corridor.id, day)
