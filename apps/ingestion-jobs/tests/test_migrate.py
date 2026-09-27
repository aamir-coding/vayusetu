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


def test_semicolons_in_comments_do_not_split_statements():
    s = Settings(project="p", dataset="core", bq_location="asia-south1", reference_bucket=None, corridor_ids=())
    for name, sql in migrate.statements(s):
        assert sql.upper().startswith(("CREATE", "ALTER")), f"{name}: statement starts with {sql[:30]!r}"
        assert "--" not in sql


@pytest.mark.integration
def test_earth_engine_one_day_export():
    """Live: needs ADC + an EE-registered GOOGLE_CLOUD_PROJECT."""
    from vayusetu_ingest.config import load_settings
    from vayusetu_ingest.jobs import earth_engine

    earth_engine.run(load_settings(), start="2026-09-20", days=1)


def test_ci_deploys_every_terraform_job():
    """infra/cloudbuild/ingestion-jobs.yaml must update the image of EVERY job
    Terraform creates -- a job left out keeps running stale code."""
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    tf = (root / "infra/terraform/modules/state-deployment/ingestion.tf").read_text(encoding="utf-8")
    block = tf.split("ingestion_jobs = {")[1].split("\n  }\n")[0]
    tf_jobs = set(re.findall(r"^\s{4}(ingest-[a-z0-9-]+)\s*=", block, re.M))
    ci = (root / "infra/cloudbuild/ingestion-jobs.yaml").read_text(encoding="utf-8")
    ci_jobs = set(re.search(r"_JOBS: '([^']+)'", ci).group(1).split())
    assert tf_jobs and tf_jobs == ci_jobs
