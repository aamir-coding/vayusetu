"""H3 + corridor geometry helpers. BigQuery has no native H3, so every cell
id is computed here (DB_SCHEMA.md, H3 implementation note)."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from functools import cached_property

import h3

from .config import DATA_DIR, OPERATIONAL_H3_RES


def cell(lat: float, lng: float, res: int = OPERATIONAL_H3_RES) -> str:
    return h3.latlng_to_cell(lat, lng, res)


def parent(h3_index: str, res: int) -> str:
    return h3.cell_to_parent(h3_index, res)


def centroid(h3_index: str) -> tuple[float, float]:
    return h3.cell_to_latlng(h3_index)


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def point_in_ring(lat: float, lng: float, ring: list[list[float]]) -> bool:
    """Ray casting on a GeoJSON ring ([lng, lat] pairs)."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


@dataclass(frozen=True)
class Corridor:
    id: str
    name: str
    states: list[str]
    population: int
    grap_framework_active: bool
    boundary_file: str
    cpcb_states: list[str]
    grap_thresholds: dict | None = None
    extra: dict = field(default_factory=dict, compare=False, hash=False)

    @cached_property
    def geojson(self) -> dict:
        return json.loads((DATA_DIR / "seed" / self.boundary_file).read_text(encoding="utf-8"))

    @cached_property
    def polygon(self) -> dict:
        return self.geojson["features"][0]["geometry"]

    def contains(self, lat: float, lng: float) -> bool:
        return point_in_ring(lat, lng, self.polygon["coordinates"][0])

    def cells(self, res: int = OPERATIONAL_H3_RES) -> list[str]:
        return sorted(h3.geo_to_cells(self.polygon, res))


def load_corridors(only: tuple[str, ...] = ()) -> list[Corridor]:
    raw = json.loads((DATA_DIR / "seed" / "corridors.json").read_text(encoding="utf-8"))["corridors"]
    out = [
        Corridor(
            id=c["id"],
            name=c["name"],
            states=c["states"],
            population=c["population"],
            grap_framework_active=c["grapFrameworkActive"],
            grap_thresholds=c.get("grapThresholds"),
            boundary_file=c["boundaryFile"],
            cpcb_states=c.get("cpcbStates", []),
        )
        for c in raw
    ]
    return [c for c in out if not only or c.id in only]


def corridor_for(lat: float, lng: float, corridors: list[Corridor]) -> Corridor | None:
    return next((c for c in corridors if c.contains(lat, lng)), None)
