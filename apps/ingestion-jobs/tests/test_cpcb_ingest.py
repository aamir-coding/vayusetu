import sys
from pathlib import Path

# Add apps/ingestion-jobs directory to sys.path so 'src' is discoverable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))



from datetime import datetime, timezone
import pytest
from src.cpcbIngest import transform_records, ALLOWED_POLLUTANTS, ALLOWED_AQI_CATEGORIES


def test_schema_enums_and_field_mapping():
    """Verify pollutant_min/max/avg map directly and enums conform to BigQuery DDL."""
    sample_records = [
        {
            "station_id": "DEL001",
            "station_name": "Anand Vihar, Delhi",
            "latitude": 28.6469,
            "longitude": 77.3160,
            "last_update": "25-09-2026 14:00:00",
            "pollutant_id": "PM2.5",
            "pollutant_min": "45.0",
            "pollutant_max": "180.5",
            "pollutant_avg": "120.2",
            "aqi": "120",
            "aqi_category": "Moderate"
        },
        {
            "station_id": "MUM002",
            "station_name": "Bandra, Mumbai",
            "latitude": 19.0596,
            "longitude": 72.8295,
            "last_update": "25-09-2026 14:00:00",
            "pollutant_id": "NO2",
            "pollutant_min": "10.0",
            "pollutant_max": "45.0",
            "pollutant_avg": "25.0",
            "aqi": "25",
            "aqi_category": "Good"
        }
    ]

    transformed = transform_records(sample_records)
    assert len(transformed) == 2

    for row in transformed:
        if row["pollutant_id"]:
            assert row["pollutant_id"] in ALLOWED_POLLUTANTS
        if row["aqi_category"]:
            assert row["aqi_category"] in ALLOWED_AQI_CATEGORIES

        assert isinstance(row["pollutant_min"], (float, type(None)))
        assert isinstance(row["pollutant_max"], (float, type(None)))
        assert isinstance(row["pollutant_avg"], (float, type(None)))

        assert row["h3_index"] is not None
        assert len(row["h3_index"]) > 5
        assert row["source"] == "CPCB_DATA_GOV_IN"


def test_freshness_ingested_at():
    """Verify ingested_at timestamp is fresh within expected hourly cadence."""
    sample_records = [
        {
            "station_id": "DEL001",
            "latitude": 28.6469,
            "longitude": 77.3160,
            "pollutant_id": "PM2.5"
        }
    ]

    transformed = transform_records(sample_records)
    assert len(transformed) == 1

    row = transformed[0]
    ingested_time = datetime.fromisoformat(row["ingested_at"])
    now_utc = datetime.now(timezone.utc)

    time_diff = abs((now_utc - ingested_time).total_seconds())
    assert time_diff < 900