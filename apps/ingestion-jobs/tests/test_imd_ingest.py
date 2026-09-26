import sys
from pathlib import Path

# Add apps/ingestion-jobs directory to sys.path so 'src' is discoverable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datetime import datetime, timezone
import pytest
from src.imdIngest import transform_records

def test_meteorology_schema_and_field_mapping():
    """Verify IMD API data correctly maps to BigQuery meteorology_features schema."""
    sample_records = [
        {
            "station_id": "IMD_DEL_001",
            "latitude": 28.6469,
            "longitude": 77.3160,
            "observation_time": "26-09-2026 14:00:00",
            "wind_speed": "5.2",
            "wind_direction": "275",
            "temperature": "34.1",
            "humidity": "42.5",
            "boundary_layer_height": "1450.5",
            "precipitation": "0.0"
        },
        {
            "station_id": "IMD_MUM_002",
            "latitude": 19.0596,
            "longitude": 72.8295,
            # Testing fallback aliases and missing values
            "wind_speed": 3.1,
            "blh": 850.0,
            "rainfall": 12.5
        }
    ]

    transformed = transform_records(sample_records)
    assert len(transformed) == 2

    delhi = transformed[0]
    mumbai = transformed[1]

    # Validate H3 and Source
    for row in transformed:
        assert row["h3_index"] is not None
        assert len(row["h3_index"]) > 5
        assert row["source"] == "IMD"
        assert row["observation_date"] is not None

    # Validate specific mappings
    assert delhi["station_id"] == "IMD_DEL_001"
    assert delhi["wind_speed_ms"] == 5.2
    assert delhi["wind_direction_deg"] == 275.0
    assert delhi["temperature_c"] == 34.1
    assert delhi["relative_humidity_pct"] == 42.5
    assert delhi["boundary_layer_height_m"] == 1450.5
    assert delhi["precipitation_mm"] == 0.0

    assert mumbai["station_id"] == "IMD_MUM_002"
    assert mumbai["wind_speed_ms"] == 3.1
    assert mumbai["temperature_c"] is None  # Missing in payload
    assert mumbai["boundary_layer_height_m"] == 850.0  # Mapped from 'blh'
    assert mumbai["precipitation_mm"] == 12.5  # Mapped from 'rainfall'


def test_freshness_ingested_at():
    """Verify ingested_at timestamp is fresh."""
    sample_records = [
        {
            "station_id": "TEST_01",
            "latitude": 28.6469,
            "longitude": 77.3160
        }
    ]

    transformed = transform_records(sample_records)
    row = transformed[0]
    
    ingested_time = datetime.fromisoformat(row["ingested_at"])
    now_utc = datetime.now(timezone.utc)

    time_diff = abs((now_utc - ingested_time).total_seconds())
    assert time_diff < 900  # Should be ingested within the last 15 minutes