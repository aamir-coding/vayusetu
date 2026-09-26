# VayuSetu — Database Schema
> Source: PRD §3.4 · Steward: Engineer 4 (BigQuery/DDL, owns `data/schemas/`) · Engineer 2 co-signs any Firestore collection/index change (their services write these documents)

Two persistence layers, deliberately different jobs: **Firestore** for operational/real-time/low-latency reads (what the apps render live), **BigQuery** for analytical/high-volume/joined data (what the ML models train and score against). Canonical TypeScript shapes for the Firestore-backed entities are in `API_CONTRACTS.md` §4.1 — this file documents persistence shape, indexes, and DDL; the two are complementary views of the same entities, not duplicated definitions.

## Firestore Collections

| Collection | Document ID | Purpose |
|---|---|---|
| `users/{userId}` | Firebase Auth UID | Identity, role, jurisdiction, language preference |
| `submissions/{submissionId}` | Auto-ID | Citizen/field-worker report metadata |
| `analysisResults/{submissionId}` | Same as parent `Submission.id` (1:1) | Gemini-derived structured assessment |
| `hotspots/{h3Index}_{timestampHour}` | Composite | Hourly fused hotspot score per H3 cell |
| `forecasts/{corridorId}_{forecastRunTimestamp}` | Composite | Per-corridor forecast run |
| `alerts/{alertId}` | Deterministic: `hotspot_<HotspotCell.id>` / `forecast_<ForecastRun.id>_<stateCode>` (Pub/Sub redelivery can never duplicate an alert) | Routed, status-tracked official alert |
| `corridors/{corridorId}` | Slug: `ncr-airshed`, `mumbai-pune-corridor` (canonical list: `data/seed/corridors.json`; written only by the ingestion `seed` job) | Corridor configuration, incl. GRAP thresholds |
| `monitoringStations/{stationId}` | CPCB/SPCB station code | Official reference monitor registry |
| `resourceRequests/{requestId}` | Auto-ID | Cross-jurisdiction resource coordination |
| `federationExchange/{stateCode}/sharedModels/{modelId}` | Sub-collection | Local view of models shared to/from the National Exchange |

**Required composite indexes:**
- `submissions`: `(userId ASC, uploadedAt DESC)` — "my reports" screen · `(status ASC, uploadedAt DESC)` — analysis-backlog / review queue
- `alerts`: `(assignedJurisdiction.stateCode ASC, assignedJurisdiction.districtCode ASC, status ASC, severity DESC, createdAt DESC)` — the single query powering Officer Deshmukh's entire dashboard view
- `hotspots`: `(corridorId ASC, timestampHour DESC)` — corridor heatmap time-scrubbing
- `resourceRequests`: `(jurisdiction.stateCode ASC, status ASC, createdAt DESC)`

**Security rules:** every read/write is gated on the caller's custom-claim `role` and `jurisdiction` matching the target document's `jurisdiction` field (officials read/write only within their assigned state/district; citizens read only their own `submissions`/`analysisResults`). All `analysisResults` writes are server-only (Admin SDK, `analysis-service`'s service account) — no client ever writes a Gemini output directly.

## BigQuery Tables (`vayusetu.core`, and `vayusetu.federation_exchange` for the shared dataset)

```sql
CREATE TABLE `vayusetu.core.satellite_features` (
  h3_index STRING NOT NULL,
  corridor_id STRING,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  no2_column_mol_m2 FLOAT64,
  aerosol_index FLOAT64,
  aod_550nm FLOAT64,
  fire_detection_count INT64,
  fire_frp_sum FLOAT64,
  source_dataset STRING NOT NULL,      -- e.g. 'COPERNICUS/S5P/NRTI/L3_NO2'
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY observation_date
CLUSTER BY h3_index, corridor_id;

CREATE TABLE `vayusetu.core.meteorology_features` (
  h3_index STRING NOT NULL,
  station_id STRING,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  wind_speed_ms FLOAT64,
  wind_direction_deg FLOAT64,
  temperature_c FLOAT64,
  relative_humidity_pct FLOAT64,
  boundary_layer_height_m FLOAT64,
  precipitation_mm FLOAT64,
  source STRING NOT NULL,              -- 'IMD'
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY observation_date
CLUSTER BY h3_index;

CREATE TABLE `vayusetu.core.ground_truth_aqi` (
  station_id STRING NOT NULL,          -- CPCB/SPCB station code
  station_name STRING,
  h3_index STRING NOT NULL,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  pollutant_id STRING,                 -- PM2.5 | PM10 | NO2 | SO2 | CO | O3 | NH3 | Pb
  pollutant_min FLOAT64,
  pollutant_max FLOAT64,
  pollutant_avg FLOAT64,
  aqi INT64,
  aqi_category STRING,                 -- good|satisfactory|moderate|poor|very_poor|severe
  source STRING NOT NULL,              -- 'CPCB_DATA_GOV_IN'
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY observation_date
CLUSTER BY station_id, h3_index;
-- Field names mirror the actual data.gov.in real-time AQI resource
-- (Country, State, City, Station, Last Update, Latitude, Longitude,
-- Pollutant Id, Pollutant Min, Pollutant Max, Pollutant Avg) so the
-- ingestion job is a near-direct field mapping, not a reinterpretation.

CREATE TABLE `vayusetu.core.citizen_reports_agg` (
  h3_index STRING NOT NULL,
  corridor_id STRING,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  report_count INT64,
  avg_severity FLOAT64,
  source_classification_mode STRING,   -- most common classification this cell/hour
  avg_confidence_score FLOAT64,
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY observation_date
CLUSTER BY h3_index, corridor_id;
-- Populated by a Cloud Run Job that rolls up Firestore `analysisResults`
-- into hourly, cell-level aggregates -- individual citizen submissions
-- never appear in BigQuery in raw, user-attributable form.

CREATE TABLE `vayusetu.core.hotspot_training_dataset` (
  h3_index STRING NOT NULL,
  corridor_id STRING NOT NULL,
  observation_date DATE NOT NULL,
  observation_hour INT64,
  -- joined features from satellite_features, meteorology_features,
  -- citizen_reports_agg, and lagged ground_truth_aqi --
  no2_column_mol_m2 FLOAT64,
  aerosol_index FLOAT64,
  fire_detection_count INT64,
  wind_speed_ms FLOAT64,
  boundary_layer_height_m FLOAT64,
  citizen_report_count INT64,
  citizen_avg_severity FLOAT64,
  nearest_monitor_distance_km FLOAT64,
  nearest_monitor_aqi FLOAT64,
  -- label, computed retrospectively once ground truth is available --
  is_hidden_hotspot BOOL,
  actual_aqi_deviation FLOAT64,
  dataset_split STRING                 -- 'train' | 'validation' | 'test'
)
PARTITION BY observation_date
CLUSTER BY corridor_id, h3_index;

CREATE TABLE `vayusetu.core.forecast_training_dataset` (
  corridor_id STRING NOT NULL,
  ts TIMESTAMP NOT NULL,
  aqi_lag_24h FLOAT64,
  aqi_lag_48h FLOAT64,
  aqi_lag_7d_avg FLOAT64,
  met_forecast_wind_speed_ms FLOAT64,
  met_forecast_boundary_layer_height_m FLOAT64,
  is_harvest_season BOOL,
  is_diwali_window BOOL,
  day_of_week INT64,
  aqi_next_24h FLOAT64,                -- forecast label
  aqi_next_48h FLOAT64,                -- forecast label
  aqi_next_72h FLOAT64,                -- forecast label
  dataset_split STRING
)
PARTITION BY DATE(ts)
CLUSTER BY corridor_id;
```

```sql
-- Shared dataset, separate GCP project boundary (data-sovereignty
-- boundary -- see ARCHITECTURE_OVERVIEW.md): every row here is already
-- k-anonymized and coarsened before it leaves a state's own project.
CREATE TABLE `vayusetu.federation_exchange.hotspot_summary` (
  source_state_code STRING NOT NULL,
  h3_index_generalized STRING NOT NULL, -- lower H3 resolution than the internal grid
  week_start_date DATE NOT NULL,
  avg_hotspot_confidence FLOAT64,
  underlying_report_count_bucket STRING, -- e.g. '10-50', '50-200', '200+' (never exact)
  model_version STRING NOT NULL,
  shared_at TIMESTAMP NOT NULL
)
PARTITION BY week_start_date
CLUSTER BY source_state_code;
```

## Tables added 26 Sep 2026 (realignment, Phase 0)
DDL in `data/schemas/`, applied by `python -m vayusetu_ingest migrate` (idempotent; column additions live in `data/schemas/migrations/`). All `observation_date`/`observation_hour` columns are **UTC**.

| Table | Purpose |
|---|---|
| `core.h3_cells` | Every res-8 cell per corridor + parents (res 7 EE sampling, res 6 federated, res 4 weather) + nearest official monitor and `has_monitor_within_radius` (3 km). All feature joins go through it — BigQuery has no H3. |
| `core.monitoring_stations` | Official monitor registry from the CPCB feed (mirrored to Firestore `monitoringStations`). |
| `core.modeled_aqi` | Google Air Quality API modeled hourly AQI (`ind_cpcb`) at monitor sites and sampled unmonitored cells. Never counted as a monitor. |
| `core.meteorology_forecast` | Google Weather API 72 h hourly forecast per res-4 cell (forecast-model covariates). |

Column changes: `satellite_features.burn_scar_fraction` (Sentinel-2 dNBR), `meteorology_features.corridor_id` (source is now `GOOGLE_WEATHER_API` / `ERA5_LAND`; IMD has no open API), `citizen_reports_agg.contributor_count` (federation k-anonymity). `ground_truth_aqi.pollutant_*` hold CPCB **sub-indices**; `aqi` is the station NAQI (max sub-index, ≥ 3 pollutants incl. PM).

## H3 Spatial Indexing (implementation note)
BigQuery has no native H3 support (its native spatial clustering uses S2). H3 cell indices are computed **at the application layer** using `h3-js` (Node services) and `h3` (Python ingestion jobs), centralized in `packages/h3-utils`, and stored as an indexed `STRING` column in both Firestore and BigQuery. Native BigQuery `GEOGRAPHY`/`ST_*` functions handle polygon-containment and distance queries (e.g., "is this H3 cell inside the NCR corridor boundary"). The community-maintained Carto Analytics Toolbox for BigQuery can additionally do H3 conversions natively in SQL — an optional Phase 2 convenience, not a dependency.
