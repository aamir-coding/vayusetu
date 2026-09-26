"""Google Maps Platform Weather API -> core.meteorology_features (observed,
hourly) and core.meteorology_forecast (--mode forecast, every 6 h).

Replaces the Week-2 IMD job: IMD publishes no open real-time API, and that
job fell back to inserting a fabricated Delhi record whenever its
placeholder URL failed. One point per res-4 weather cell per corridor.
"""

from __future__ import annotations

import logging
from datetime import datetime

from google.cloud import bigquery

from .. import geo
from ..bq import merge_rows, utc_now_iso
from ..config import MET_H3_RES, Settings, require_env
from ..http import get_json, session

log = logging.getLogger(__name__)

BASE = "https://weather.googleapis.com/v1"
KMH_TO_MS = 1 / 3.6


def weather_points(corridors: list[geo.Corridor]) -> list[dict]:
    points = []
    for c in corridors:
        cells = c.cells(MET_H3_RES) or [geo.cell(*reversed(c.polygon["coordinates"][0][0]), MET_H3_RES)]
        for cell in cells:
            lat, lng = geo.centroid(cell)
            points.append({"h3_index": cell, "corridor_id": c.id, "lat": lat, "lng": lng})
    return points


def _fields(h: dict) -> dict:
    wind = h.get("wind") or {}
    speed = (wind.get("speed") or {}).get("value")
    unit = (wind.get("speed") or {}).get("unit", "KILOMETERS_PER_HOUR")
    qpf = ((h.get("precipitation") or {}).get("qpf") or {}).get("quantity")
    return {
        "wind_speed_ms": None if speed is None else (speed * KMH_TO_MS if unit == "KILOMETERS_PER_HOUR" else speed),
        "wind_direction_deg": (wind.get("direction") or {}).get("degrees"),
        "temperature_c": (h.get("temperature") or {}).get("degrees"),
        "relative_humidity_pct": h.get("relativeHumidity"),
        "precipitation_mm": qpf,
    }


def _start(h: dict) -> datetime:
    return datetime.fromisoformat((h.get("interval") or {})["startTime"].replace("Z", "+00:00"))


def observed_rows(point: dict, hours: list[dict], now: str) -> list[dict]:
    rows = []
    for h in hours:
        ts = _start(h)
        rows.append({
            "h3_index": point["h3_index"],
            "station_id": f"gwx:{point['h3_index']}",
            "corridor_id": point["corridor_id"],
            "observation_date": ts.date().isoformat(),
            "observation_hour": ts.hour,
            "boundary_layer_height_m": None,  # not in the Weather API; ERA5 backfill provides it where available
            "source": "GOOGLE_WEATHER_API",
            "ingested_at": now,
            **_fields(h),
        })
    return rows


def forecast_rows(point: dict, hours: list[dict], issued_at: str) -> list[dict]:
    return [{
        "h3_index": point["h3_index"],
        "corridor_id": point["corridor_id"],
        "issued_at": issued_at,
        "target_ts": _start(h).isoformat(),
        "source": "GOOGLE_WEATHER_API",
        "ingested_at": issued_at,
        **_fields(h),
    } for h in hours]


def _paged(s, url: str, params: dict, list_key: str) -> list[dict]:
    out: list[dict] = []
    params = dict(params)
    while True:
        data = get_json(s, url, params=params)
        out.extend(data.get(list_key, []))
        token = data.get("nextPageToken")
        if not token:
            return out
        params["pageToken"] = token


def run(settings: Settings, mode: str = "observed", hours: int = 3, **_: object) -> None:
    key = require_env("GOOGLE_MAPS_API_KEY")
    points = weather_points(geo.load_corridors(settings.corridor_ids))
    s, now, rows = session(), utc_now_iso(), []
    for p in points:
        params = {"key": key, "location.latitude": p["lat"], "location.longitude": p["lng"], "unitsSystem": "METRIC"}
        if mode == "forecast":
            hrs = _paged(s, f"{BASE}/forecast/hours:lookup", {**params, "hours": 72, "pageSize": 24}, "forecastHours")
            rows.extend(forecast_rows(p, hrs, now))
        else:
            hrs = _paged(s, f"{BASE}/history/hours:lookup", {**params, "hours": min(hours, 24), "pageSize": 24}, "historyHours")
            rows.extend(observed_rows(p, hrs, now))
    log.info("weather[%s]: %d points -> %d rows", mode, len(points), len(rows))
    if not rows:
        raise SystemExit("weather: API returned no hours")
    bq = bigquery.Client(project=settings.project, location=settings.bq_location)
    if mode == "forecast":
        merge_rows(bq, settings.table("meteorology_forecast"), rows, ["h3_index", "issued_at", "target_ts"])
    else:
        merge_rows(bq, settings.table("meteorology_features"), rows, ["h3_index", "observation_date", "observation_hour", "source"])
