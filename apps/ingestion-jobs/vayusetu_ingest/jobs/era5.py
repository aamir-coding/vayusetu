"""ERA5 reanalysis (Earth Engine ECMWF/ERA5/HOURLY) -> core.meteorology_features.

Historical weather for model training, one row per res-4 weather cell per
UTC hour (the same grid the Weather API job writes live). ERA5 is the only
source here with boundary-layer height -- the key pollution-trapping
variable -- but it lags real time by ~5 days, so it is a PAST-ONLY feature
(forecast model: "unavailable at forecast" covariate; hotspot model: not a
feature at all, so training and live scoring never diverge).

Daily job re-reads the last 8 days (lag + late revisions, merged away);
--start/--days for backfill.
"""

from __future__ import annotations

import logging
import math
from datetime import date, datetime, timedelta, timezone

from google.cloud import bigquery

from .. import geo
from ..bq import merge_rows, utc_now_iso
from ..config import MET_H3_RES, Settings
from .earth_engine import _init_ee
from .weather import weather_points

log = logging.getLogger(__name__)

COLLECTION = "ECMWF/ERA5/HOURLY"
BANDS = [
    "u_component_of_wind_10m",
    "v_component_of_wind_10m",
    "temperature_2m",
    "dewpoint_temperature_2m",
    "total_precipitation",
    "boundary_layer_height",
]
LOOKBACK_DAYS = 8


def relative_humidity(temp_k: float, dewpoint_k: float) -> float:
    """Magnus formula, %."""
    t, td = temp_k - 273.15, dewpoint_k - 273.15
    a, b = 17.625, 243.04
    return round(100 * math.exp(a * td / (b + td)) / math.exp(a * t / (b + t)), 1)


def to_row(props: dict, now: str) -> dict | None:
    ts = datetime.fromtimestamp(props["t"] / 1000, tz=timezone.utc)
    u, v = props.get("u_component_of_wind_10m"), props.get("v_component_of_wind_10m")
    temp, dew = props.get("temperature_2m"), props.get("dewpoint_temperature_2m")
    if u is None or v is None or temp is None:
        return None
    return {
        "h3_index": props["h3_index"],
        "station_id": f"era5:{props['h3_index']}",
        "corridor_id": props["corridor_id"],
        "observation_date": ts.date().isoformat(),
        "observation_hour": ts.hour,
        "wind_speed_ms": round(math.hypot(u, v), 3),
        # meteorological convention: direction the wind blows FROM
        "wind_direction_deg": round((math.degrees(math.atan2(-u, -v)) + 360) % 360, 1),
        "temperature_c": round(temp - 273.15, 2),
        "relative_humidity_pct": relative_humidity(temp, dew) if dew is not None else None,
        "boundary_layer_height_m": props.get("boundary_layer_height"),
        "precipitation_mm": None if props.get("total_precipitation") is None else round(props["total_precipitation"] * 1000, 3),
        "source": "ERA5",
        "ingested_at": now,
    }


def _day_rows(ee, points_fc, day: date, now: str) -> list[dict]:
    col = ee.ImageCollection(COLLECTION).filterDate(day.isoformat(), (day + timedelta(days=1)).isoformat()).select(BANDS)

    def sample(img):
        t = img.get("system:time_start")
        return img.reduceRegions(collection=points_fc, reducer=ee.Reducer.first(), scale=27830).map(
            lambda f: f.set("t", t).setGeometry(None)
        )

    feats = ee.FeatureCollection(col.map(sample)).flatten().getInfo()["features"]
    return [r for r in (to_row(f["properties"], now) for f in feats) if r]


def run(settings: Settings, start: str | None = None, days: int | None = None, **_: object) -> None:
    ee = _init_ee(settings.project)
    points = weather_points(geo.load_corridors(settings.corridor_ids))
    points_fc = ee.FeatureCollection([
        ee.Feature(ee.Geometry.Point(p["lng"], p["lat"]), {"h3_index": p["h3_index"], "corridor_id": p["corridor_id"]})
        for p in points
    ])
    today = datetime.now(timezone.utc).date()
    first = date.fromisoformat(start) if start else today - timedelta(days=LOOKBACK_DAYS)
    n_days = days if days else LOOKBACK_DAYS
    bq = bigquery.Client(project=settings.project, location=settings.bq_location)
    now = utc_now_iso()
    batch: list[dict] = []
    for offset in range(n_days):
        day = first + timedelta(days=offset)
        if day >= today:
            break
        rows = _day_rows(ee, points_fc, day, now)
        batch.extend(rows)
        if not rows:
            log.info("era5: no data for %s yet (ERA5 lags ~5 days)", day)
        if len(batch) >= 20_000:
            merge_rows(bq, settings.table("meteorology_features"), batch, ["h3_index", "observation_date", "observation_hour", "source"])
            batch = []
        log.info("era5: %s -> %d rows (%d points, res %d)", day, len(rows), len(points), MET_H3_RES)
    if batch:
        merge_rows(bq, settings.table("meteorology_features"), batch, ["h3_index", "observation_date", "observation_hour", "source"])
