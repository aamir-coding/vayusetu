"""Google Maps Platform Air Quality API -> core.modeled_aqi.

Points: every official monitor site (history backfill for the forecast
model) plus a deterministic sample of grid cells WITHOUT a monitor nearby
(labels for the hidden-hotspot model: "what was the air like where nobody
measures it"). Daily job with --hours 26 (overlap is merged away); one-off
backfill with --hours 720 (the API's 30-day history limit).
"""

from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime

from google.cloud import bigquery

from .. import aqi, geo
from ..bq import merge_rows, utc_now_iso
from ..config import Settings, require_env
from ..http import post_json, session

log = logging.getLogger(__name__)

BASE = "https://airquality.googleapis.com/v1"
EXTRA = ["LOCAL_AQI", "POLLUTANT_CONCENTRATION", "DOMINANT_POLLUTANT_CONCENTRATION"]
# ppb -> ug/m3 at 25 C, 1 atm (molar mass / 24.45)
PPB_TO_UGM3 = {"no2": 1.88, "o3": 1.96, "so2": 2.62}
POLLUTANT_TO_CPCB = {"pm25": "PM2.5", "pm10": "PM10", "no2": "NO2", "o3": "OZONE", "co": "CO", "so2": "SO2", "nh3": "NH3"}


def _conc(pollutants: list[dict], code: str) -> float | None:
    for p in pollutants or []:
        if p.get("code") == code:
            c = p.get("concentration") or {}
            value, units = c.get("value"), c.get("units")
            if value is None:
                return None
            return value * PPB_TO_UGM3.get(code, 1.0) if units == "PARTS_PER_BILLION" else value
    return None


def to_row(info: dict, point: dict, now: str) -> dict | None:
    ts = datetime.fromisoformat(info["dateTime"].replace("Z", "+00:00"))
    cpcb = next((i for i in info.get("indexes", []) if i.get("code") == "ind_cpcb"), None)
    if cpcb is None:
        return None
    value = cpcb.get("aqi")
    return {
        "h3_index": point["h3_index"],
        "corridor_id": point["corridor_id"],
        "station_id": point.get("station_id"),
        "observation_date": ts.date().isoformat(),
        "observation_hour": ts.hour,
        "aqi": value,
        "aqi_category": aqi.category(value),
        "dominant_pollutant": POLLUTANT_TO_CPCB.get(cpcb.get("dominantPollutant", ""), cpcb.get("dominantPollutant")),
        "pm25_ugm3": _conc(info.get("pollutants"), "pm25"),
        "pm10_ugm3": _conc(info.get("pollutants"), "pm10"),
        "no2_ugm3": _conc(info.get("pollutants"), "no2"),
        "source": "GOOGLE_AIR_QUALITY_API",
        "ingested_at": now,
    }


def fetch_history(s, key: str, lat: float, lng: float, hours: int) -> list[dict]:
    body = {
        "location": {"latitude": lat, "longitude": lng},
        "hours": hours,
        "pageSize": 168,
        "extraComputations": EXTRA,
        "universalAqi": False,
    }
    out: list[dict] = []
    while True:
        data = post_json(s, f"{BASE}/history:lookup?key={key}", body)
        out.extend(data.get("hoursInfo", []))
        token = data.get("nextPageToken")
        if not token:
            return out
        body["pageToken"] = token


def sample_cells(cells: list[dict], per_corridor: int) -> list[dict]:
    """Stable sample (hash order), so daily runs extend the same series."""
    by_corridor: dict[str, list[dict]] = {}
    for c in cells:
        by_corridor.setdefault(c["corridor_id"], []).append(c)
    out = []
    for rows in by_corridor.values():
        rows.sort(key=lambda r: hashlib.sha1(r["h3_index"].encode()).hexdigest())
        out.extend(rows[:per_corridor])
    return out


def load_points(bq: bigquery.Client, settings: Settings, per_corridor: int) -> list[dict]:
    corridor_filter = ""
    if settings.corridor_ids:
        corridor_filter = "AND corridor_id IN UNNEST(@corridors)"
    cfg = bigquery.QueryJobConfig(query_parameters=[bigquery.ArrayQueryParameter("corridors", "STRING", list(settings.corridor_ids))])
    stations = [
        {"h3_index": r.h3_index, "corridor_id": r.corridor_id, "station_id": r.station_id, "lat": r.lat, "lng": r.lng}
        for r in bq.query(
            f"SELECT station_id, corridor_id, h3_index, lat, lng FROM `{settings.table('monitoring_stations')}` "
            f"WHERE is_official {corridor_filter}", job_config=cfg).result()
    ]
    unmonitored = [
        dict(r) for r in bq.query(
            f"SELECT h3_index, corridor_id, lat, lng FROM `{settings.table('h3_cells')}` "
            f"WHERE NOT has_monitor_within_radius {corridor_filter}", job_config=cfg).result()
    ]
    return stations + sample_cells(unmonitored, per_corridor)


def run(settings: Settings, hours: int = 26, **_: object) -> None:
    key = require_env("GOOGLE_MAPS_API_KEY")
    bq = bigquery.Client(project=settings.project, location=settings.bq_location)
    points = load_points(bq, settings, int(os.getenv("AQ_SAMPLE_CELLS_PER_CORRIDOR", "100")))
    if not points:
        raise SystemExit("No points: run `cpcb` then `seed` first (stations + h3_cells)")
    s, now, rows, failures = session(), utc_now_iso(), [], 0
    for p in points:
        try:
            for info in fetch_history(s, key, p["lat"], p["lng"], hours):
                row = to_row(info, p, now)
                if row:
                    rows.append(row)
        except Exception as exc:  # one bad point shouldn't sink 200 good ones
            failures += 1
            log.warning("air-quality: %s failed: %s", p["h3_index"], exc)
    log.info("air-quality: %d points, %d failed, %d rows", len(points), failures, len(rows))
    if failures > len(points) // 2:
        raise SystemExit(f"air-quality: {failures}/{len(points)} points failed (key restrictions? quota?)")
    merge_rows(bq, settings.table("modeled_aqi"), rows, ["h3_index", "observation_date", "observation_hour", "source"])
