"""Runtime configuration shared by every ingestion job.

H3 resolutions are fixed here and nowhere else. They must match
packages/h3-utils (OPERATIONAL=8, FEDERATED=6) -- a mismatch silently breaks
every h3_index join in BigQuery (the Week-2 CPCB/IMD jobs wrote res 7).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

OPERATIONAL_H3_RES = 8  # packages/h3-utils H3_RESOLUTIONS.OPERATIONAL
FEDERATED_H3_RES = 6  # packages/h3-utils H3_RESOLUTIONS.FEDERATED
SATELLITE_SAMPLE_RES = 7  # Earth Engine samples at res-7 centroids (~5 km2, finer than S5P pixels)
MET_H3_RES = 4  # one weather point per ~1,770 km2 cell (ERA5 is ~9-31 km)
HIDDEN_HOTSPOT_MONITOR_RADIUS_KM = 3.0  # PRODUCT_SPEC Feature 2 default

# Repo-relative in dev; copied to /app/data in the image (see Dockerfile).
DATA_DIR = Path(os.getenv("VAYUSETU_DATA_DIR", Path(__file__).resolve().parents[3] / "data"))


@dataclass(frozen=True)
class Settings:
    project: str
    dataset: str
    bq_location: str
    reference_bucket: str | None
    corridor_ids: tuple[str, ...]

    def table(self, name: str) -> str:
        return f"{self.project}.{self.dataset}.{name}"


def load_settings() -> Settings:
    project = os.getenv("GOOGLE_CLOUD_PROJECT")
    if not project:
        raise SystemExit("GOOGLE_CLOUD_PROJECT is required")
    corridors = tuple(c.strip() for c in os.getenv("CORRIDOR_IDS", "").split(",") if c.strip())
    return Settings(
        project=project,
        dataset=os.getenv("BQ_DATASET", "core"),
        bq_location=os.getenv("BQ_LOCATION", "asia-south1"),
        reference_bucket=os.getenv("REFERENCE_BUCKET") or None,
        corridor_ids=corridors,
    )


def require_env(name: str) -> str:
    """Secrets arrive as env vars (Cloud Run secret refs). Missing = hard fail:
    a job that silently runs without its key writes nothing and looks healthy."""
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is not set (Cloud Run: mount the secret; local: export it)")
    return value
