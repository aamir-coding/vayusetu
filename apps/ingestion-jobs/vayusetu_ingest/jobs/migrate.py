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
        for stmt in (s.strip() for s in sql.split(";")):
            if stmt and not all(line.strip().startswith("--") or not line.strip() for line in stmt.splitlines()):
                out.append((f.name, stmt))
    return out


def run(settings: Settings, **_: object) -> None:
    client = bigquery.Client(project=settings.project, location=settings.bq_location)
    for name, stmt in statements(settings):
        client.query(stmt).result()
        log.info("applied %s", name)
