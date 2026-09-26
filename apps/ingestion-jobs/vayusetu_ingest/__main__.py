"""python -m vayusetu_ingest <job> [options]

Jobs (schedule in infra/terraform/modules/state-deployment/ingestion.tf):
  migrate       apply data/schemas DDL + migrations (idempotent)
  cpcb          CPCB real-time feed -> ground_truth_aqi, monitoring_stations     hourly
  seed          corridors (Firestore/GCS) + core.h3_cells                          after cpcb / on change
  air-quality   Air Quality API history -> modeled_aqi   (--hours 26 daily, 720 backfill)
  weather       Weather API -> meteorology_features       (--mode observed hourly | forecast 6-hourly)
  earth-engine  EE satellite features -> satellite_features (daily; --start/--days for backfill)
  rollup        analysisResults -> citizen_reports_agg     hourly
"""

from __future__ import annotations

import argparse
import importlib
import logging
import sys

from .config import load_settings

JOBS = {
    "migrate": "migrate",
    "cpcb": "cpcb",
    "seed": "seed",
    "air-quality": "air_quality",
    "weather": "weather",
    "earth-engine": "earth_engine",
    "rollup": "rollup",
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vayusetu_ingest")
    parser.add_argument("job", choices=sorted(JOBS))
    parser.add_argument("--hours", type=int)
    parser.add_argument("--mode", choices=["observed", "forecast"])
    parser.add_argument("--start", help="YYYY-MM-DD (earth-engine backfill)")
    parser.add_argument("--days", type=int)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    module = importlib.import_module(f".jobs.{JOBS[args.job]}", __package__)
    kwargs = {k: v for k, v in vars(args).items() if k != "job" and v is not None}
    module.run(load_settings(), **kwargs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
