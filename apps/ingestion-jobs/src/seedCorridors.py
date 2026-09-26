import os
from google.cloud import firestore

PROJECT_ID = os.getenv("GCP_PROJECT_ID", "vayusetu-ncr-dev")
BUCKET_NAME = "vayusetu-ncr-dev-corridors"

CORRIDORS_DATA = [
    {
        "id": "ncr_airshed",
        "name": "National Capital Region Airshed",
        "states": ["Delhi", "Haryana", "Uttar Pradesh", "Rajasthan"],
        "boundaryGeoJsonStorageUrl": f"https://storage.googleapis.com/{BUCKET_NAME}/ncr_airshed.geojson",
        "population": 46000000,
        "monitoringStationIds": [
            "station_delhi_ito",
            "station_delhi_anand_vihar",
            "station_noida_sec62",
            "station_gurugram_sec51"
        ],
        "grapFrameworkActive": True,
        "grapThresholds": {
            "stage_1_poor": 201,
            "stage_2_very_poor": 301,
            "stage_3_severe": 401,
            "stage_4_severe_plus": 450
        }
    },
    {
        "id": "mumbai_pune",
        "name": "Mumbai-Pune Industrial Corridor",
        "states": ["Maharashtra"],
        "boundaryGeoJsonStorageUrl": f"https://storage.googleapis.com/{BUCKET_NAME}/mumbai_pune.geojson",
        "population": 28000000,
        "monitoringStationIds": [
            "station_mumbai_bandra",
            "station_mumbai_colaba",
            "station_pune_shivajinagar"
        ],
        "grapFrameworkActive": False,
        "grapThresholds": {
            "stage_1_poor": 201,
            "stage_2_very_poor": 301,
            "stage_3_severe": 401,
            "stage_4_severe_plus": 450
        }
    }
]

def seed_corridors():
    db = firestore.Client(project=PROJECT_ID)
    collection_ref = db.collection("corridors")
    
    print(f"Seeding corridors into Firestore collection 'corridors' on project '{PROJECT_ID}'...")
    for corridor in CORRIDORS_DATA:
        doc_id = corridor["id"]
        doc_ref = collection_ref.document(doc_id)
        doc_ref.set(corridor)
        print(f"Successfully wrote corridor doc: {doc_id}")

if __name__ == "__main__":
    seed_corridors()