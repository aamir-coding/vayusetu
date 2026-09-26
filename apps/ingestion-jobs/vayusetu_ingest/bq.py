"""Idempotent BigQuery writes.

The Week-2 jobs used insert_rows_json, so every rerun (Scheduler retries,
manual backfills) appended duplicates into training tables. Everything now
goes: load into a short-lived staging table -> one MERGE on the natural key.
Reruns overwrite, never duplicate.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone

from google.cloud import bigquery

log = logging.getLogger(__name__)


_NULL_SENTINEL = "\\u0000<null>"


def _key_match(col: str, nullable: bool) -> str:
    # Plain equality for REQUIRED keys. Nullable keys (observation_hour) must
    # still match NULL to NULL, but `IS NOT DISTINCT FROM` defeats BigQuery's
    # hash join -> nested loop -> "Query exceeded resource limits" at ~50k
    # rows (hit by the year-long OpenAQ backfill). COALESCE keeps it hashable.
    if not nullable:
        return f"T.`{col}` = S.`{col}`"
    return f"COALESCE(CAST(T.`{col}` AS STRING), '{_NULL_SENTINEL}') = COALESCE(CAST(S.`{col}` AS STRING), '{_NULL_SENTINEL}')"


def merge_sql(
    target: str,
    staging: str,
    key_cols: Sequence[str],
    all_cols: Sequence[str],
    nullable_keys: Sequence[str] = (),
    prune: tuple[str, str, str] | None = None,
) -> str:
    """prune = (partition_column, min_date, max_date): restricts the target
    scan to the partitions this batch can touch."""
    on = " AND ".join(_key_match(c, c in nullable_keys) for c in key_cols)
    if prune:
        col, lo, hi = prune
        on += f" AND T.`{col}` BETWEEN '{lo}' AND '{hi}'"
    updates = ", ".join(f"`{c}` = S.`{c}`" for c in all_cols if c not in key_cols)
    cols = ", ".join(f"`{c}`" for c in all_cols)
    vals = ", ".join(f"S.`{c}`" for c in all_cols)
    matched = f"WHEN MATCHED THEN UPDATE SET {updates} " if updates else ""
    return (
        f"MERGE `{target}` T USING `{staging}` S ON {on} "
        f"{matched}WHEN NOT MATCHED THEN INSERT ({cols}) VALUES ({vals})"
    )


def dedupe(rows: list[dict], key_cols: Sequence[str]) -> list[dict]:
    """MERGE fails if two source rows match one target row; last one wins."""
    by_key: dict[tuple, dict] = {}
    for row in rows:
        by_key[tuple(row.get(c) for c in key_cols)] = row
    return list(by_key.values())


def merge_rows(client: bigquery.Client, target: str, rows: list[dict], key_cols: Sequence[str]) -> int:
    if not rows:
        log.warning("merge_rows(%s): nothing to write", target)
        return 0
    rows = dedupe(rows, key_cols)
    table = client.get_table(target)
    col_names = [f.name for f in table.schema]
    unknown = set().union(*(r.keys() for r in rows)) - set(col_names)
    if unknown:
        raise ValueError(f"{target}: rows carry columns not in the table schema: {sorted(unknown)}")

    staging = f"{target}__stg_{uuid.uuid4().hex[:10]}"
    staging_table = bigquery.Table(staging, schema=table.schema)
    staging_table.expires = datetime.now(timezone.utc) + timedelta(hours=2)
    client.create_table(staging_table)
    try:
        cfg = bigquery.LoadJobConfig(schema=table.schema, write_disposition="WRITE_TRUNCATE")
        client.load_table_from_json(rows, staging, job_config=cfg).result()
        nullable = [f.name for f in table.schema if f.name in key_cols and f.mode != "REQUIRED"]
        prune = None
        part = table.time_partitioning.field if table.time_partitioning else None
        if part and part in key_cols:
            values = sorted(str(r[part]) for r in rows if r.get(part) is not None)
            if values and len(values) == len(rows):
                prune = (part, values[0], values[-1])
        client.query(merge_sql(target, staging, key_cols, col_names, nullable, prune)).result()
    finally:
        client.delete_table(staging, not_found_ok=True)
    log.info("merged %d rows into %s", len(rows), target)
    return len(rows)


def replace_table(client: bigquery.Client, target: str, rows: list[dict]) -> int:
    """Full rewrite, for small derived reference tables (h3_cells, stations)."""
    table = client.get_table(target)
    cfg = bigquery.LoadJobConfig(schema=table.schema, write_disposition="WRITE_TRUNCATE")
    client.load_table_from_json(rows, target, job_config=cfg).result()
    log.info("replaced %s with %d rows", target, len(rows))
    return len(rows)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
