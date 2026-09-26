"""Firestore analysisResults -> core.citizen_reports_agg (hourly).

PRODUCT_SPEC Feature 1: a report folds into the hourly aggregate feeding the
Hotspot Fusion Engine ONLY if its confidenceScore and cross-validation
agreement clear configured thresholds. Individual submissions never reach
BigQuery in user-attributable form -- only per-cell/hour aggregates, plus a
distinct-contributor count that federation's k-anonymity check needs.
"""

from __future__ import annotations

import logging
import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from google.cloud import bigquery, firestore

from .. import geo
from ..bq import merge_rows, utc_now_iso
from ..config import Settings

log = logging.getLogger(__name__)


def qualifies(result: dict, min_conf: float, min_agreement: float) -> bool:
    if result.get("needsHumanReview") or result.get("sourceClassification") in (None, "indeterminate"):
        return False
    if (result.get("confidenceScore") or 0) < min_conf:
        return False
    agreement = (result.get("crossValidation") or {}).get("agreementScore")
    return agreement is None or agreement >= min_agreement


def aggregate(pairs: list[tuple[dict, dict]], corridors: list[geo.Corridor], now: str) -> list[dict]:
    """pairs = (submission, analysisResult)."""
    buckets: dict[tuple[str, str, int], list[tuple[dict, dict]]] = defaultdict(list)
    for sub, res in pairs:
        ts = datetime.fromisoformat(sub["uploadedAt"].replace("Z", "+00:00")).astimezone(timezone.utc)
        buckets[(sub["h3Index"], ts.date().isoformat(), ts.hour)].append((sub, res))
    rows = []
    for (cell, day, hour), items in buckets.items():
        g = items[0][0]["geo"]
        corridor = geo.corridor_for(g["lat"], g["lng"], corridors)
        results = [r for _, r in items]
        rows.append({
            "h3_index": cell,
            "corridor_id": corridor.id if corridor else None,
            "observation_date": day,
            "observation_hour": hour,
            "report_count": len(items),
            "contributor_count": len({s["userId"] for s, _ in items}),
            "avg_severity": sum(r["severityEstimate"] for r in results) / len(results),
            "source_classification_mode": Counter(r["sourceClassification"] for r in results).most_common(1)[0][0],
            "avg_confidence_score": sum(r["confidenceScore"] for r in results) / len(results),
            "ingested_at": now,
        })
    return rows


def run(settings: Settings, hours: int = 3, **_: object) -> None:
    min_conf = float(os.getenv("ROLLUP_MIN_CONFIDENCE", "0.5"))
    min_agreement = float(os.getenv("ROLLUP_MIN_AGREEMENT", "0.4"))
    fs = firestore.Client(project=settings.project)
    # Hour-aligned window over uploadedAt (the bucketing field), so every
    # bucket touched is complete and the MERGE replaces it with a full count.
    start = (datetime.now(timezone.utc) - timedelta(hours=hours)).replace(minute=0, second=0, microsecond=0)
    subs = [d.to_dict() for d in fs.collection("submissions").where("uploadedAt", ">=", start.strftime("%Y-%m-%dT%H:%M:%S.000Z")).stream()]
    pairs = []
    for sub in subs:
        snap = fs.collection("analysisResults").document(sub["id"]).get()
        if snap.exists and qualifies(snap.to_dict(), min_conf, min_agreement):
            pairs.append((sub, snap.to_dict()))
    rows = aggregate(pairs, geo.load_corridors(settings.corridor_ids), utc_now_iso())
    log.info("rollup: %d submissions since %s, %d qualified, %d cell-hours", len(subs), start.isoformat(), len(pairs), len(rows))
    if rows:
        bq = bigquery.Client(project=settings.project, location=settings.bq_location)
        merge_rows(bq, settings.table("citizen_reports_agg"), rows, ["h3_index", "observation_date", "observation_hour"])
