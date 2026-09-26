"""CPCB real-time AQI (data.gov.in) -> core.ground_truth_aqi (live, measured).

The station registry itself comes from the `openaq` job; stations here are
re-keyed onto it by location.

Hourly Cloud Run Job. The feed is a snapshot of every station's latest
per-pollutant sub-indices, stamped with IST local time.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from google.cloud import bigquery, firestore

from .. import aqi, geo
from ..bq import merge_rows, utc_now_iso
from ..config import Settings, require_env
from ..http import get_json, session

log = logging.getLogger(__name__)

RESOURCE_ID = "3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69"  # "Real time Air Quality Index from various locations"
IST = timezone(timedelta(hours=5, minutes=30))
PAGE = 1000


def fetch_all(api_key: str) -> list[dict]:
    s = session()
    records: list[dict] = []
    offset = 0
    while True:
        data = get_json(
            s,
            f"https://api.data.gov.in/resource/{RESOURCE_ID}",
            params={"api-key": api_key, "format": "json", "limit": PAGE, "offset": offset},
        )
        batch = data.get("records", [])
        records.extend(batch)
        total = int(data.get("total", len(records)) or 0)
        offset += PAGE
        if not batch or offset >= total:
            return records


def _num(v) -> float | None:
    try:
        return None if v in (None, "", "NA") else float(v)
    except (TypeError, ValueError):
        return None


def station_slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:120]


def agency_for(name: str) -> str:
    # Feed names end in the operating agency: "Anand Vihar, Delhi - DPCC",
    # "Sector-62, Noida - IMD", "... - CPCB".
    suffix = name.rsplit("-", 1)[-1].strip().upper() if "-" in name else ""
    if suffix == "CPCB":
        return "CPCB"
    if suffix.endswith("PCB") or suffix in {"DPCC", "PPCB", "HSPCB", "UPPCB", "RSPCB", "MPCB"}:
        return "SPCB"
    return "other"


def parse_ist(value: str | None) -> datetime | None:
    for fmt in ("%d-%m-%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M:%S"):
        try:
            return datetime.strptime(value or "", fmt).replace(tzinfo=IST).astimezone(timezone.utc)
        except ValueError:
            continue
    return None


def transform(records: list[dict], corridors: list[geo.Corridor]) -> tuple[list[dict], list[dict]]:
    """-> (ground_truth rows, station rows). Only stations inside this
    deployment's corridors are kept -- a state project holds its own data."""
    by_station: dict[tuple[str, datetime], dict] = defaultdict(lambda: {"pollutants": {}})
    for rec in records:
        lat, lng = _num(rec.get("latitude")), _num(rec.get("longitude"))
        name = (rec.get("station") or rec.get("station_name") or "").strip()
        observed = parse_ist(rec.get("last_update"))
        pollutant = aqi.normalize_pollutant(rec.get("pollutant_id"))
        if lat is None or lng is None or not name or observed is None or pollutant is None:
            continue
        corridor = geo.corridor_for(lat, lng, corridors)
        if corridor is None:
            continue
        entry = by_station[(name, observed)]
        entry.update(name=name, lat=lat, lng=lng, corridor=corridor.id, city=rec.get("city"), state=rec.get("state"))
        entry["pollutants"][pollutant] = (
            _num(rec.get("min_value", rec.get("pollutant_min"))),
            _num(rec.get("max_value", rec.get("pollutant_max"))),
            _num(rec.get("avg_value", rec.get("pollutant_avg"))),
        )

    now = utc_now_iso()
    gt_rows: list[dict] = []
    stations: dict[str, dict] = {}
    for (name, observed), e in by_station.items():
        sid = station_slug(name)
        cell = geo.cell(e["lat"], e["lng"])
        station_index = aqi.station_aqi({p: v[2] for p, v in e["pollutants"].items()})
        for pollutant, (mn, mx, avg) in e["pollutants"].items():
            gt_rows.append({
                "station_id": sid,
                "station_name": name,
                "h3_index": cell,
                "observation_date": observed.date().isoformat(),
                "observation_hour": observed.hour,
                "pollutant_id": pollutant,
                "pollutant_min": mn,
                "pollutant_max": mx,
                "pollutant_avg": avg,
                "aqi": station_index,
                "aqi_category": aqi.category(station_index),
                "source": "CPCB_DATA_GOV_IN",
                "ingested_at": now,
            })
        prev = stations.get(sid)
        if prev is None or observed.isoformat() > prev["last_reading_at"]:
            stations[sid] = {
                "station_id": sid,
                "name": name,
                "agency": agency_for(name),
                "city": e.get("city"),
                "state": e.get("state"),
                "corridor_id": e["corridor"],
                "lat": e["lat"],
                "lng": e["lng"],
                "h3_index": cell,
                "is_official": True,
                "last_reading_at": observed.isoformat(),
                "updated_at": now,
            }
    return gt_rows, list(stations.values())


def station_doc(row: dict) -> dict:
    """API_CONTRACTS.md MonitoringStation."""
    return {
        "id": row["station_id"],
        "name": row["name"],
        "agency": row["agency"],
        "geo": {"lat": row["lat"], "lng": row["lng"]},
        "h3Index": row["h3_index"],
        "isOfficial": row["is_official"],
        "lastReadingAt": row["last_reading_at"],
        "corridorId": row["corridor_id"],
    }


def write_station_docs(settings: Settings, stations: list[dict]) -> None:
    fs = firestore.Client(project=settings.project)
    batch = fs.batch()
    for i, row in enumerate(stations, 1):
        batch.set(fs.collection("monitoringStations").document(row["station_id"]), station_doc(row), merge=True)
        if i % 400 == 0:
            batch.commit()
            batch = fs.batch()
    batch.commit()


REGISTRY_MATCH_KM = 0.3


def align_to_registry(gt_rows: list[dict], stations: list[dict], registry: list[dict]) -> tuple[list[dict], list[dict]]:
    """data.gov.in and OpenAQ spell station names differently ("Anand Vihar,
    Delhi - DPCC" vs "Anand Vihar, New Delhi - DPCC"). Re-key a feed station
    onto the registry station at the same site (< 300 m) so both sources land
    on one station_id; unmatched stations keep their own slug."""
    remap = {}
    for st in stations:
        best = min(registry, key=lambda r: geo.haversine_km(st["lat"], st["lng"], r["lat"], r["lng"]), default=None)
        if best and geo.haversine_km(st["lat"], st["lng"], best["lat"], best["lng"]) <= REGISTRY_MATCH_KM:
            remap[st["station_id"]] = best["station_id"]
    for row in gt_rows:
        row["station_id"] = remap.get(row["station_id"], row["station_id"])
    unmatched = [s for s in stations if s["station_id"] not in remap]
    return gt_rows, unmatched


def run(settings: Settings, **_: object) -> None:
    corridors = geo.load_corridors(settings.corridor_ids)
    records = fetch_all(require_env("DATA_GOV_IN_API_KEY"))
    gt_rows, stations = transform(records, corridors)
    log.info("cpcb: %d feed records -> %d rows, %d stations in %s", len(records), len(gt_rows), len(stations), [c.id for c in corridors])
    if not gt_rows:
        raise SystemExit("CPCB feed produced no rows for this deployment's corridors -- failing so the scheduler alerts")

    bq = bigquery.Client(project=settings.project, location=settings.bq_location)
    registry = [dict(r) for r in bq.query(
        f"SELECT station_id, lat, lng FROM `{settings.table('monitoring_stations')}`").result()]
    gt_rows, new_stations = align_to_registry(gt_rows, stations, registry)
    merge_rows(bq, settings.table("ground_truth_aqi"), gt_rows,
               ["station_id", "observation_date", "observation_hour", "pollutant_id", "source"])
    if new_stations:
        merge_rows(bq, settings.table("monitoring_stations"), new_stations, ["station_id"])
        write_station_docs(settings, new_stations)
