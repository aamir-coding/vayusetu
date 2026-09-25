import os
import pytest
from src.earthEngineIngest import init_ee, run_integration_pipeline

# Path to the seeded NCR Airshed GeoJSON relative to ingestion-jobs
GEOJSON_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "data", "corridors", "ncr_airshed.geojson")
)

def test_earth_engine_pipeline_run():
    init_ee()
    
    # Run against a known valid satellite date
    rows = run_integration_pipeline(GEOJSON_PATH, date_str="2024-05-01")
    
    assert len(rows) > 0, "No records returned from Earth Engine sample"
    
    first_row = rows[0]
    required_fields = [
        "h3_index",
        "corridor_id",
        "observation_date",
        "observation_hour",
        "source_dataset",
        "ingested_at"
    ]
    
    # Verify no NULLs in required DDL columns
    for field in required_fields:
        assert first_row[field] is not None, f"Required field '{field}' is NULL"
        assert first_row[field] != "", f"Required field '{field}' is empty"