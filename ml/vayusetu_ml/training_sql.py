"""Renders and runs ml/sql/*.sql (training-set builders)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from .specs import TrainingWindow

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def render(kind: str, project: str, dataset: str = "core") -> str:
    sql = (SQL_DIR / f"{kind}_training.sql").read_text(encoding="utf-8")
    return sql.replace("{dataset}", f"{project}.{dataset}")


def time_split_window(end: datetime, days: int, validate_frac: float = 0.15, test_frac: float = 0.15) -> TrainingWindow:
    """Chronological split: [start .. validate_from) TRAIN, then VALIDATE,
    then the most recent `test_frac` TEST -- neighbouring hours of one smog
    episode never straddle train and test."""
    end = end.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(days=days)
    span = end - start
    test_from = end - span * test_frac
    validate_from = test_from - span * validate_frac
    iso = lambda d: d.isoformat()  # noqa: E731
    return TrainingWindow(iso(start), iso(end), iso(validate_from), iso(test_from))


def build(kind: str, project: str, window: TrainingWindow, dataset: str = "core", location: str = "asia-south1") -> dict:
    """CREATE OR REPLACE the training table; returns row/label stats for model labels + cards."""
    from google.cloud import bigquery

    client = bigquery.Client(project=project, location=location)
    params = [
        bigquery.ScalarQueryParameter(name, "TIMESTAMP", value)
        for name, value in (("start_ts", window.start), ("end_ts", window.end),
                            ("validate_from", window.validate_from), ("test_from", window.test_from))
    ]
    client.query(render(kind, project, dataset), job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    table = f"{project}.{dataset}.{kind}_training_dataset"
    label = "is_hotspot = 'hotspot'" if kind == "hotspot" else "FALSE"
    stats = list(client.query(
        f"SELECT COUNT(*) AS `rows`, COUNTIF({label}) AS positives, COUNTIF(split = 'TRAIN') AS train, "
        f"COUNTIF(split = 'VALIDATE') AS validate, COUNTIF(split = 'TEST') AS test FROM `{table}`"
    ).result())[0]
    return {"table": table, **dict(stats)}
