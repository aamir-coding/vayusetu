"""Reference data: corridors (Firestore + GCS boundary), core.h3_cells.

Run after `migrate`, and again whenever the station registry changes (the
`cpcb` job's first run creates it) so nearest-monitor distances are current.
Also removes the pre-contract corridor docs/rows (`ncr_airshed`,
`mumbai_pune`) the Week-2 seed wrote -- alert-service drops every event whose
corridor fails its schema, so those docs must not linger.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import h3
from google.cloud import bigquery, firestore, storage

from .. import geo
from ..bq import replace_table, utc_now_iso
from ..config import (
    FEDERATED_H3_RES,
    HIDDEN_HOTSPOT_MONITOR_RADIUS_KM,
    MET_H3_RES,
    SATELLITE_SAMPLE_RES,
    Settings,
)

log = logging.getLogger(__name__)

LEGACY_CORRIDOR_IDS = ("ncr_airshed", "mumbai_pune")

# Stations are ~1-10 km apart; checking the k-ring around each station is
# far cheaper than all-pairs over ~60k cells.
_NEAREST_SEARCH_K = 40  # res-8 edge ~0.46 km -> ~18 km search radius


def build_cells(corridors: list[geo.Corridor], stations: list[dict]) -> list[dict]:
    now = utc_now_iso()
    best: dict[str, tuple[float, str]] = {}
    for st in stations:
        origin = geo.cell(st["lat"], st["lng"])
        for c in h3.grid_disk(origin, _NEAREST_SEARCH_K):
            lat, lng = h3.cell_to_latlng(c)
            d = geo.haversine_km(lat, lng, st["lat"], st["lng"])
            if c not in best or d < best[c][0]:
                best[c] = (d, st["station_id"])

    rows = []
    for corridor in corridors:
        for c in corridor.cells():
            lat, lng = h3.cell_to_latlng(c)
            dist, sid = best.get(c, (None, None))
            rows.append({
                "h3_index": c,
                "corridor_id": corridor.id,
                "lat": lat,
                "lng": lng,
                "h3_res7": h3.cell_to_parent(c, SATELLITE_SAMPLE_RES),
                "h3_res6": h3.cell_to_parent(c, FEDERATED_H3_RES),
                "h3_res4": h3.cell_to_parent(c, MET_H3_RES),
                "nearest_station_id": sid,
                "nearest_station_distance_km": round(dist, 3) if dist is not None else None,
                "has_monitor_within_radius": dist is not None and dist <= HIDDEN_HOTSPOT_MONITOR_RADIUS_KM,
                "updated_at": now,
            })
    return rows


def corridor_doc(c: geo.Corridor, boundary_url: str, station_ids: list[str], created_at: str) -> dict:
    """Exactly API_CONTRACTS.md Corridor (alert-service validates it with Zod)."""
    doc = {
        "id": c.id,
        "name": c.name,
        "states": c.states,
        "boundaryGeoJsonStorageUrl": boundary_url,
        "population": c.population,
        "monitoringStationIds": station_ids,
        "grapFrameworkActive": c.grap_framework_active,
        "createdAt": created_at,
    }
    if c.grap_thresholds:
        doc["grapThresholds"] = c.grap_thresholds
    return doc


def run(settings: Settings, **_: object) -> None:
    corridors = geo.load_corridors(settings.corridor_ids)
    bq = bigquery.Client(project=settings.project, location=settings.bq_location)
    fs = firestore.Client(project=settings.project)

    stations = [dict(r) for r in bq.query(
        f"SELECT station_id, corridor_id, lat, lng FROM `{settings.table('monitoring_stations')}` WHERE is_official"
    ).result()]
    log.info("seed: %d official stations in registry", len(stations))

    gcs = storage.Client(project=settings.project) if settings.reference_bucket else None
    for c in corridors:
        if gcs:
            blob = gcs.bucket(settings.reference_bucket).blob(f"corridors/{c.id}.geojson")
            blob.upload_from_string(json.dumps(c.geojson), content_type="application/geo+json")
            url = f"gs://{settings.reference_bucket}/corridors/{c.id}.geojson"
        else:
            log.warning("REFERENCE_BUCKET unset; boundaryGeoJsonStorageUrl will be a repo path")
            url = f"repo://data/seed/{c.boundary_file}"
        ref = fs.collection("corridors").document(c.id)
        existing = ref.get()
        created = (existing.to_dict() or {}).get("createdAt") if existing.exists else None
        ids = sorted(s["station_id"] for s in stations if s["corridor_id"] == c.id)
        ref.set(corridor_doc(c, url, ids, created or datetime.now(timezone.utc).isoformat()))
        log.info("seed: corridors/%s (%d stations)", c.id, len(ids))

    for legacy in LEGACY_CORRIDOR_IDS:
        if fs.collection("corridors").document(legacy).get().exists:
            fs.collection("corridors").document(legacy).delete()
            log.info("seed: deleted legacy corridors/%s", legacy)
    ids = ", ".join(f"'{i}'" for i in LEGACY_CORRIDOR_IDS)
    bq.query(f"DELETE FROM `{settings.table('satellite_features')}` WHERE corridor_id IN ({ids})").result()

    replace_table(bq, settings.table("h3_cells"), build_cells(corridors, stations))
