"""OpenAQ v3 -> official monitor registry + MEASURED CPCB history.

OpenAQ republishes CPCB CAAQMS station data (history back to 2016 for NCR)
but currently lags real time by ~2 days, so it is the source for:
  * core.monitoring_stations / Firestore monitoringStations (registry)
  * core.ground_truth_aqi, source 'CPCB_VIA_OPENAQ' (measured, for training
    and calibration). Live readings come from data.gov.in (`cpcb` job) when
    that portal responds, and the Air Quality API (`air-quality`, modeled).

Hourly concentrations become CPCB NAQI the way CPCB computes it: 24-h
rolling mean for PM2.5/PM10/NO2/SO2 (>= 16 valid hours), 8-h rolling mean
for O3/CO (>= 6 valid hours), then sub-index, then station AQI = max
sub-index with >= 3 pollutants incl. PM. `pollutant_avg` therefore holds a
SUB-INDEX, same semantics as the data.gov.in feed.

Modes: --mode latest (6-hourly; re-reads the last 4 days so late-arriving
data is merged in) | --mode backfill --days N (one-off, e.g. 365).
Free tier is 60 requests/min, so every call is paced.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from google.cloud import bigquery

from .. import aqi, geo
from ..bq import merge_rows, utc_now_iso
from ..config import Settings, require_env
from ..http import session
from .cpcb import agency_for, station_slug, write_station_docs

log = logging.getLogger(__name__)

BASE = "https://api.openaq.org/v3"
MIN_INTERVAL_S = 1.05  # 60 req/min free tier
STALE_AFTER_DAYS = 30  # stations silent longer than this are decommissioned
LATEST_WINDOW_DAYS = 4

PARAM_TO_CPCB = {"pm25": "PM2.5", "pm10": "PM10", "no2": "NO2", "so2": "SO2", "o3": "OZONE", "co": "CO"}
# CPCB averaging: (window hours, minimum valid hours)
AVERAGING = {"PM2.5": (24, 16), "PM10": (24, 16), "NO2": (24, 16), "SO2": (24, 16), "OZONE": (8, 6), "CO": (8, 6)}
PPB_TO_UGM3 = {"no2": 1.88, "so2": 2.62, "o3": 1.96, "co": 1.145}


def normalize(param: str, value: float | None, units: str) -> float | None:
    """-> ug/m3, except CO -> mg/m3 (CPCB breakpoint units)."""
    if value is None or value < 0:
        return None
    u = (units or "").replace("Â", "").lower()
    if u == "ppb":
        value *= PPB_TO_UGM3.get(param, 1.0)
    elif u == "ppm":
        value *= PPB_TO_UGM3.get(param, 1.0) * 1000
    elif u == "mg/m³":
        value *= 1000
    return value / 1000 if param == "co" else value


def hour_of(result: dict) -> datetime:
    """OpenAQ hours run on IST half-hours (23:30-00:30 UTC); bucket at the midpoint."""
    start = datetime.fromisoformat(result["period"]["datetimeFrom"]["utc"].replace("Z", "+00:00"))
    return (start + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)


def rolling_sub_indices(series: dict[str, dict[datetime, float]], hours: list[datetime]) -> dict[datetime, dict[str, int]]:
    out: dict[datetime, dict[str, int]] = defaultdict(dict)
    for pollutant, points in series.items():
        window, minimum = AVERAGING[pollutant]
        for t in hours:
            vals = [points[t - timedelta(hours=k)] for k in range(window) if (t - timedelta(hours=k)) in points]
            if len(vals) >= minimum:
                si = aqi.sub_index(pollutant, sum(vals) / len(vals))
                if si is not None:
                    out[t][pollutant] = si
    return out


def ground_truth_rows(station_id: str, name: str, cell: str, series: dict[str, dict[datetime, float]],
                      start: datetime, end: datetime, now: str) -> list[dict]:
    hours = []
    t = start
    while t <= end:
        hours.append(t)
        t += timedelta(hours=1)
    rows = []
    for t, subs in sorted(rolling_sub_indices(series, hours).items()):
        station_index = aqi.station_aqi(subs)
        for pollutant, si in subs.items():
            rows.append({
                "station_id": station_id,
                "station_name": name,
                "h3_index": cell,
                "observation_date": t.date().isoformat(),
                "observation_hour": t.hour,
                "pollutant_id": pollutant,
                "pollutant_min": None,
                "pollutant_max": None,
                "pollutant_avg": float(si),
                "aqi": station_index,
                "aqi_category": aqi.category(station_index),
                "source": "CPCB_VIA_OPENAQ",
                "ingested_at": now,
            })
    return rows


class Client:
    def __init__(self, key: str):
        self.s = session()
        self.s.headers["X-API-Key"] = key
        self._last = 0.0

    def get(self, path: str, **params) -> dict:
        wait = MIN_INTERVAL_S - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        resp = self.s.get(f"{BASE}{path}", params=params, timeout=60)
        if resp.status_code == 429:
            time.sleep(int(resp.headers.get("X-Ratelimit-Reset", "60")) + 1)
            return self.get(path, **params)
        resp.raise_for_status()
        return resp.json()

    def paged(self, path: str, **params) -> list[dict]:
        out, page = [], 1
        while True:
            data = self.get(path, limit=1000, page=page, **params)
            out.extend(data.get("results", []))
            if len(data.get("results", [])) < 1000:
                return out
            page += 1


def bbox(c: geo.Corridor) -> str:
    ring = c.polygon["coordinates"][0]
    lngs, lats = [p[0] for p in ring], [p[1] for p in ring]
    return f"{min(lngs)},{min(lats)},{max(lngs)},{max(lats)}"


def active_stations(client: Client, corridors: list[geo.Corridor], now: datetime) -> list[dict]:
    stations = []
    for c in corridors:
        for loc in client.paged("/locations", bbox=bbox(c), monitor="true"):
            last = (loc.get("datetimeLast") or {}).get("utc")
            coords = loc.get("coordinates") or {}
            lat, lng = coords.get("latitude"), coords.get("longitude")
            if not last or lat is None or not c.contains(lat, lng):
                continue
            if datetime.fromisoformat(last.replace("Z", "+00:00")) < now - timedelta(days=STALE_AFTER_DAYS):
                continue
            stations.append({"loc": loc, "corridor_id": c.id, "lat": lat, "lng": lng})
    return stations


def live_sensors(client: Client, loc: dict) -> dict[str, tuple[int, str]]:
    """param -> (sensor id, units): the sensor per pollutant that reported most recently."""
    units = {s["id"]: (s["parameter"]["name"], s["parameter"]["units"]) for s in loc.get("sensors", [])}
    best: dict[str, tuple[str, int]] = {}
    for r in client.get(f"/locations/{loc['id']}/latest").get("results", []):
        sid = r.get("sensorsId")
        if sid not in units:
            continue
        param = units[sid][0]
        ts = (r.get("datetime") or {}).get("utc", "")
        if param in PARAM_TO_CPCB and ts > best.get(param, ("", 0))[0]:
            best[param] = (ts, sid)
    return {p: (sid, units[sid][1]) for p, (_, sid) in best.items()}


def run(settings: Settings, mode: str = "latest", days: int | None = None, **_: object) -> None:
    client = Client(require_env("OPENAQ_API_KEY"))
    corridors = geo.load_corridors(settings.corridor_ids)
    now_dt = datetime.now(timezone.utc)
    now = utc_now_iso()
    span = timedelta(days=days if mode == "backfill" and days else LATEST_WINDOW_DAYS)
    end = now_dt.replace(minute=0, second=0, microsecond=0)
    start = end - span
    fetch_from = start - timedelta(hours=24)  # lead-in for the 24-h rolling mean

    stations = active_stations(client, corridors, now_dt)
    log.info("openaq[%s]: %d active stations, %s -> %s", mode, len(stations), start, end)
    if not stations:
        raise SystemExit("openaq: no active stations in corridor bbox -- check key / coverage")

    bq = bigquery.Client(project=settings.project, location=settings.bq_location)
    registry, gt_rows, failures = [], [], 0
    for st in stations:
        loc = st["loc"]
        name = loc["name"]
        sid = station_slug(name)
        cell = geo.cell(st["lat"], st["lng"])
        try:
            series: dict[str, dict[datetime, float]] = {}
            for param, (sensor_id, units) in live_sensors(client, loc).items():
                points = {}
                for r in client.paged(f"/sensors/{sensor_id}/hours",
                                      datetime_from=fetch_from.isoformat().replace("+00:00", "Z"),
                                      datetime_to=end.isoformat().replace("+00:00", "Z")):
                    v = normalize(param, r.get("value"), units)
                    if v is not None:
                        points[hour_of(r)] = v
                if points:
                    series[PARAM_TO_CPCB[param]] = points
            gt_rows.extend(ground_truth_rows(sid, name, cell, series, start, end, now))
        except Exception as exc:
            failures += 1
            log.warning("openaq: %s failed: %s", name, exc)
        registry.append({
            "station_id": sid,
            "name": name,
            "agency": agency_for(name),
            "city": loc.get("locality"),
            "state": None,
            "corridor_id": st["corridor_id"],
            "lat": st["lat"],
            "lng": st["lng"],
            "h3_index": cell,
            "is_official": True,
            "last_reading_at": loc["datetimeLast"]["utc"],
            "updated_at": now,
        })
        # Flush per batch so a long backfill makes progress even if it later dies.
        if len(gt_rows) > 50_000:
            merge_rows(bq, settings.table("ground_truth_aqi"), gt_rows,
                       ["station_id", "observation_date", "observation_hour", "pollutant_id", "source"])
            gt_rows = []

    if failures > len(stations) // 2:
        raise SystemExit(f"openaq: {failures}/{len(stations)} stations failed")
    merge_rows(bq, settings.table("ground_truth_aqi"), gt_rows,
               ["station_id", "observation_date", "observation_hour", "pollutant_id", "source"])
    merge_rows(bq, settings.table("monitoring_stations"), registry, ["station_id"])
    write_station_docs(settings, registry)
    log.info("openaq: %d stations registered, %d failed", len(registry), failures)
