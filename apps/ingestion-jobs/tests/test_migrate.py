import pytest

from vayusetu_ingest.config import Settings
from vayusetu_ingest.jobs import migrate


def test_statements_target_the_project_dataset():
    s = Settings(project="p", dataset="core", bq_location="asia-south1", reference_bucket=None, corridor_ids=())
    stmts = migrate.statements(s)
    names = [n for n, _ in stmts]
    assert "h3_cells.sql" in names and "001_satellite_burn_scar.sql" in names
    assert names.index("001_satellite_burn_scar.sql") > names.index("satellite_features.sql")
    for _, sql in stmts:
        assert "`core." not in sql
        assert "`p.core." in sql


@pytest.mark.integration
def test_earth_engine_one_day_export():
    """Live: needs ADC + an EE-registered GOOGLE_CLOUD_PROJECT."""
    from vayusetu_ingest.config import load_settings
    from vayusetu_ingest.jobs import earth_engine

    earth_engine.run(load_settings(), start="2026-09-20", days=1)
