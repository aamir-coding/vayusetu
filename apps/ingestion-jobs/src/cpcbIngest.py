import os
import sys
import logging
from datetime import datetime, timezone
import requests
from google.cloud import bigquery
from google.cloud import secretmanager
import h3

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

PROJECT_ID = os.getenv("GCP_PROJECT", "vayusetu-ncr-dev")
DATASET_ID = os.getenv("BQ_DATASET", "core")
TABLE_ID = os.getenv("BQ_TABLE", "ground_truth_aqi")
SECRET_NAME = os.getenv("CPCB_SECRET_NAME", "cpcb-api-key")
RESOURCE_ID = os.getenv("DATA_GOV_IN_RESOURCE_ID", "3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69")

ALLOWED_POLLUTANTS = {"PM2.5", "PM10", "NO2", "NH3", "SO2", "CO", "OZONE"}
ALLOWED_AQI_CATEGORIES = {"Good", "Satisfactory", "Moderate", "Poor", "Very Poor", "Severe"}


def get_api_key(project_id: str, secret_id: str) -> str:
    """Retrieve API key from env var or GCP Secret Manager."""
    env_key = os.getenv("DATA_GOV_IN_API_KEY")
    if env_key:
        return env_key.strip()

    try:
        client = secretmanager.SecretManagerServiceClient()
        name = f"projects/{project_id}/secrets/{secret_id}/versions/latest"
        response = client.access_secret_version(request={"name": name})
        return response.payload.data.decode("UTF-8").strip()
    except Exception as exc:
        logging.error(f"Failed to fetch secret '{secret_id}' from Secret Manager: {exc}")
        raise


def fetch_cpcb_feed(api_key: str, limit: int = 1000) -> list:
    """Fetch real-time ambient air quality records from data.gov.in."""
    url = f"https://api.data.gov.in/resource/{RESOURCE_ID}"
    params = {
        "api-key": api_key,
        "format": "json",
        "limit": limit
    }
    resp = requests.get(url, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get("records", [])


def transform_records(records: list) -> list:
    """
    Transforms API records to match core.ground_truth_aqi schema.
    Directly maps pollutant min/max/avg and calculates H3 index at resolution 7.
    """
    transformed = []
    now_utc = datetime.now(timezone.utc)

    def to_float(val):
        try:
            return float(val) if val is not None and val != "" and val != "NA" else None
        except (ValueError, TypeError):
            return None

    def to_int(val):
        try:
            return int(float(val)) if val is not None and val != "" and val != "NA" else None
        except (ValueError, TypeError):
            return None

    for rec in records:
        lat = rec.get("latitude")
        lng = rec.get("longitude")

        if lat is None or lng is None:
            continue
        try:
            lat = float(lat)
            lng = float(lng)
            h3_idx = h3.geo_to_h3(lat, lng, 7) if hasattr(h3, 'geo_to_h3') else h3.latlng_to_cell(lat, lng, 7)
        except Exception:
            continue

        last_update_str = rec.get("last_update", "")
        obs_date = now_utc.date().isoformat()
        obs_hour = now_utc.hour

        if last_update_str:
            for fmt in ("%d-%m-%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M:%S"):
                try:
                    dt = datetime.strptime(last_update_str, fmt)
                    obs_date = dt.date().isoformat()
                    obs_hour = dt.hour
                    break
                except ValueError:
                    pass

        pollutant_id = rec.get("pollutant_id")
        aqi_cat = rec.get("aqi_category")

        row = {
            "station_id": str(rec.get("station_id") or rec.get("station") or rec.get("id")),
            "station_name": str(rec.get("station_name") or rec.get("station", "")),
            "h3_index": h3_idx,
            "observation_date": obs_date,
            "observation_hour": obs_hour,
            "pollutant_id": str(pollutant_id) if pollutant_id else None,
            "pollutant_min": to_float(rec.get("pollutant_min")),
            "pollutant_max": to_float(rec.get("pollutant_max")),
            "pollutant_avg": to_float(rec.get("pollutant_avg")),
            "aqi": to_int(rec.get("pollutant_avg") if pollutant_id in ("PM2.5", "PM10") else rec.get("aqi")),
            "aqi_category": str(aqi_cat) if aqi_cat else None,
            "source": "CPCB_DATA_GOV_IN",
            "ingested_at": now_utc.strftime("%Y-%m-%d %H:%M:%S.%f%z")
        }

        if row["station_id"] and row["h3_index"] and row["observation_date"]:
            transformed.append(row)

    return transformed


def write_to_bigquery(rows: list, project_id: str, dataset_id: str, table_id: str):
    """Inserts transformed rows into BigQuery."""
    if not rows:
        logging.warning("No rows to insert.")
        return

    client = bigquery.Client(project=project_id)
    table_ref = f"{project_id}.{dataset_id}.{table_id}"
    errors = client.insert_rows_json(table_ref, rows)
    if errors:
        raise RuntimeError(f"BigQuery insert failed: {errors}")
    logging.info(f"Successfully inserted {len(rows)} rows into {table_ref}.")


def cpcb_ingest(request):
    """
    Cloud Function (2nd gen) HTTP entry point.
    Matches alert-service OIDC pattern invoked by Cloud Scheduler.
    """
    logging.info("Starting CPCB ingestion job via HTTP trigger...")
    api_key = get_api_key(PROJECT_ID, SECRET_NAME)
    records = fetch_cpcb_feed(api_key)
    rows = transform_records(records)
    write_to_bigquery(rows, PROJECT_ID, DATASET_ID, TABLE_ID)
    return {"status": "success", "rows_inserted": len(rows)}, 200


if __name__ == "__main__":
    class MockRequest:
        pass
    cpcb_ingest(MockRequest())