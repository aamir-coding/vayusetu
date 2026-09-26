"""Apply data/schemas/*.sql, then data/schemas/migrations/*.sql in name order.

Every statement is idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
EXISTS), so this runs safely on every deploy. `core.` in the files is
rewritten to the target project's dataset.
"""

from __future__ import annotations

import logging
import re

from google.cloud import bigquery

from ..config import DATA_DIR, Settings

log = logging.getLogger(__name__)


def statements(settings: Settings) -> list[tuple[str, str]]:
    schema_dir = DATA_DIR / "schemas"
    files = sorted(schema_dir.glob("*.sql")) + sorted((schema_dir / "migrations").glob("*.sql"))
    out = []
    for f in files:
        sql = f.read_text(encoding="utf-8")
        sql = re.sub(r"`core\.", f"`{settings.project}.{settings.dataset}.", sql)
        # Drop `--` comments BEFORE splitting on ';' -- a semicolon inside a
        # comment otherwise cuts a statement in half. (DDL has no string
        # literals containing '--'.)
        sql = re.sub(r"--[^\n]*", "", sql)
        out.extend((f.name, stmt) for stmt in (x.strip() for x in sql.split(";")) if stmt)
    return out


def run(settings: Settings, **_: object) -> None:
    client = bigquery.Client(project=settings.project, location=settings.bq_location)
    for name, stmt in statements(settings):
        client.query(stmt).result()
        log.info("applied %s", name)
