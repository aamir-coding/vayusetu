import os
import json
from datetime import datetime, timezone
import ee
import h3
from google.cloud import bigquery

# ==========================================
# REPLACE THESE PLACEHOLDERS WITH YOUR VALUES
# ==========================================
OPERATIONAL_H3_RES = 8  # <-- Replace with your operational resolution integer
FEDERATED_H3_RES = 6  # <-- Replace with your federated resolution integer
# ==========================================

PROJECT_ID = os.getenv("GCP_PROJECT_ID", "vayusetu-ncr-dev")
DATASET_ID = os.getenv("BQ_DATASET_ID", "core")
TABLE_NAME = "satellite_features"

def init_ee():
    """Initializes Earth Engine client using default project context."""
    try:
        ee.Initialize(project=PROJECT_ID)
    except Exception:
        ee.Authenticate()
        ee.Initialize(project=PROJECT_ID)

def load_boundary_polygon(geojson_path: str):
    """Loads GeoJSON boundary polygon and converts to ee.Geometry."""
    with open(geojson_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    coords = data["features"][0]["geometry"]["coordinates"]
    corridor_id = data["features"][0]["properties"].get("corridor_id", "ncr_airshed")
    return ee.Geometry.Polygon(coords), corridor_id

def latlng_to_operational_h3(lat: float, lng: float, res: int = OPERATIONAL_H3_RES) -> str:
    """Computes operational H3 cell index using h3-py."""
    if hasattr(h3, "latlng_to_cell"):
        return h3.latlng_to_cell(lat, lng, res)
    return h3.geo_to_h3(lat, lng, res)

def fetch_s5p_no2(roi: ee.Geometry, start_date: str, end_date: str):
    """Fetches Sentinel-5P NO2 column and absorbing aerosol index."""
    return (
        ee.ImageCollection("COPERNICUS/S5P/NRTI/L3_NO2")
        .filterBounds(roi)
        .filterDate(start_date, end_date)
        .select(["tropospheric_NO2_column_number_density", "absorbing_aerosol_index"])
    )

def fetch_viirs_fires(roi: ee.Geometry, start_date: str, end_date: str):
    """Fetches VIIRS active fire detections and fire radiative power."""
    return (
        ee.ImageCollection("FIRMS")
        .filterBounds(roi)
        .filterDate(start_date, end_date)
        .select(["T21", "confidence"])
    )

def fetch_s2_burn_scars(roi: ee.Geometry, start_date: str, end_date: str):
    """Fetches Sentinel-2 L2A for burn-scar delineation (B4, B8, B12)."""
    return (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(roi)
        .filterDate(start_date, end_date)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
        .select(["B4", "B8", "B12"])
    )

def format_satellite_rows(records: list, corridor_id: str, source_dataset: str) -> list:
    """Formats raw observations to match BigQuery satellite_features schema exactly."""
    now_iso = datetime.now(timezone.utc).isoformat()
    rows = []
    for rec in records:
        lat = rec.get("lat")
        lng = rec.get("lng")
        if lat is None or lng is None:
            continue

        h3_cell = latlng_to_operational_h3(lat, lng)
        obs_dt = datetime.fromisoformat(rec.get("time", now_iso))

        rows.append({
            "h3_index": h3_cell,
            "corridor_id": corridor_id,
            "observation_date": obs_dt.strftime("%Y-%m-%d"),
            "observation_hour": obs_dt.hour,
            "no2_column_mol_m2": rec.get("no2"),
            "aerosol_index": rec.get("aerosol_index"),
            "aod_550nm": rec.get("aod_550nm"),
            "fire_detection_count": rec.get("fire_count", 0),
            "fire_frp_sum": rec.get("frp_sum", 0.0),
            "source_dataset": source_dataset,
            "ingested_at": now_iso
        })
    return rows

def write_to_bigquery(rows: list):
    """Inserts processed records into BigQuery satellite_features table."""
    if not rows:
        print("No rows to write.")
        return
    client = bigquery.Client(project=PROJECT_ID)
    table_ref = f"{PROJECT_ID}.{DATASET_ID}.{TABLE_NAME}"
    errors = client.insert_rows_json(table_ref, rows)
    if errors:
        raise RuntimeError(f"BigQuery write failed: {errors}")
    print(f"Successfully inserted {len(rows)} rows into {table_ref}.")

def run_integration_pipeline(geojson_path: str, date_str: str = "2024-05-01"):
    """
    Pulls a 1-day sample of Sentinel-5P data over the ROI,
    computes H3 cells, and returns the formatted rows.
    """
    roi, corridor_id = load_boundary_polygon(geojson_path)
    
    # 1-day window for testing
    start_date = f"{date_str}T00:00:00"
    end_date = f"{date_str}T23:59:59"
    
    source = "COPERNICUS/S5P/NRTI/L3_NO2"
    s5p = fetch_s5p_no2(roi, start_date, end_date)
    
    # Sample points from the image across the corridor
    image = s5p.mean()
    sample_points = image.sample(
        region=roi,
        scale=7000,  # ~7km S5P resolution
        numPixels=10, # Keep tiny for quick integration check
        geometries=True
    )
    
    features = sample_points.getInfo().get("features", [])
    records = []
    for f in features:
        geom = f.get("geometry", {})
        coords = geom.get("coordinates", [])
        props = f.get("properties", {})
        if len(coords) >= 2:
            records.append({
                "lat": coords[1],
                "lng": coords[0],
                "time": f"{date_str}T12:00:00+00:00",
                "no2": props.get("tropospheric_NO2_column_number_density"),
                "aerosol_index": props.get("absorbing_aerosol_index"),
                "aod_550nm": None,
                "fire_count": 0,
                "frp_sum": 0.0
            })
            
    return format_satellite_rows(records, corridor_id, source)

if __name__ == "__main__":
    init_ee()
    print("Earth Engine client initialized.")
    
    geojson_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "data", "corridors", "ncr_airshed.geojson")
    )
    
    print("Extracting sample satellite records for 2024-05-01...")
    rows = run_integration_pipeline(geojson_path, date_str="2024-05-01")
    print(f"Extracted {len(rows)} rows.")
    
    print("Writing rows to BigQuery...")
    write_to_bigquery(rows)
    print("Ingestion run completed successfully.")