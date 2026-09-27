# Model card — AQI Forecast Model

| | |
|---|---|
| Registry model | `projects/818188514572/locations/asia-south1/models/4036645835147051008` (`vayusetu-aqi-forecast`) |
| Live version | **v1** (alias `default`), feature schema `fc-v2`, trained 27 Sep 2026 |
| Type | Vertex AI AutoML Forecasting, one series per official monitor, quantiles 0.1 / 0.5 / 0.9, objective minimize-quantile-loss |
| Serving | `forecaster = batch`: Vertex batch prediction in the 6-hourly `forecast-score` job; `persistence-v0` fallback |
| First live model run | 27 Sep 2026 16:00 UTC, NCR +24/+48/+72 h = 88 / 98 / 108 (the previous runs were flat persistence at 53–54) |

## What it is for
It produces the corridor's **72-hour AQI outlook** (PRODUCT_SPEC Feature 3): +24, +48 and +72 h values with a 10–90% band, the implied GRAP stage and key drivers. Officials see it in the admin Forecast view, and alert-service raises forecast alerts from `forecast.updated`.

## Design
- **Granularity:** IST calendar **days**.
  - NAQI is itself a 24 h average, and the product outputs exactly D+1, D+2 and D+3.
  - AutoML Forecasting supports only 1-hour or 1-day steps and caps a series at 3,000 steps. A year of hourly data (8,760) doesn't fit, while daily fits a full year, so the winter smog season stays in training.
- **Horizon and context:** horizon 3 steps, context 14 days (today partial).
- **Target:** daily mean station NAQI, only on days with ≥ 16 hourly readings (CPCB's 24 h completeness rule).
- **Covariates:**

  | Available at forecast time | History only |
  |---|---|
  | wind (speed, direction as a unit vector), temperature, humidity, rain; weekday, harvest window, Diwali window | boundary-layer height (ERA5), corridor fire count and mean AOD (Earth Engine) |

  History uses observed weather, and serving uses the Weather API's 72 h forecast. That is the "perfect prognosis" setup, standard in AQ forecasting. Its error is not in the evaluation below.
- **Corridor aggregation** (forecast-service): station predictions are averaged across the corridor's monitors per horizon, the way a city AQI is reported. The GRAP stage comes from the corridor's thresholds.

## Data and split
- **Size:** 22,834 station-days, 73–74 NCR stations, 26 Sep 2025 – 23 Sep 2026.
- **Split (chronological):**
  - TRAIN: to 9 Jun 2026 (16,025)
  - VALIDATE: 10 Jun – 2 Aug (3,490)
  - TEST: 3 Aug – 23 Sep (3,319)
- Forecasting is evaluated on the period after training, as it will be used.

## Evaluation (TEST, 3 Aug – 23 Sep 2026)
| Metric | Model v1 | **Persistence** (tomorrow = today) |
|---|---|---|
| MAPE (gate ≤ 40) | **22.7** | 18.0 / 25.2 / 28.3 at D+1 / D+2 / D+3 (mean **23.8**) |
| MAE (AQI points) | **23.3** | 18.9 / 26.0 / 29.2 (mean **24.7**) |
| WAPE | 21.6 | 17.7 / 24.3 / 27.3 |
| RMSE | 34.9 | — |
| R² | 0.43 | — |

The persistence numbers were computed on the same TEST rows (`core.forecast_training_dataset`). Vertex's metrics are pooled over the 3 horizons.

**The honest reading:** v1 beats persistence overall, but only **modestly (≈1 MAPE point, 1.4 AQI points pooled)**. Persistence is very strong at D+1, and the model's value is at **D+2/D+3**, where persistence degrades. It also produces a **trajectory and an uncertainty band**, which persistence cannot: the first live run showed a rising 88 → 108, where persistence would have shown a flat 53.

## Limitations and risks
- **The test window is the monsoon** (low, stable AQI). The model has not been evaluated on the Oct–Jan smog season, where errors in absolute AQI points will be much larger and where the forecast matters most. **Re-evaluate on the first 4–6 weeks of the winter season before relying on it for GRAP decisions**; until then, officials should read it as advisory.
- **Perfect-prognosis gap.** Training used observed weather, and serving uses forecast weather. Weather-forecast error adds to the error above, most at +72 h.
- **Missing drivers at serving.** Boundary-layer height, fires and AOD are history-only. Stubble-burning spikes (driven by fires) can arrive faster than the model reacts.
- **Station coverage.** The corridor value is a mean over monitors, and a monitor outage shifts it. Stations with < 16 readings on a day are dropped from that day.
- **NCR only.** Mumbai-Pune would need its own training or an imported model, re-evaluated on MH monitors.

## Retraining and rollback
- **Retrain:** `python -m vayusetu_ml run forecast`, about ₹2–4k per run, with approval. Promotion requires MAPE ≤ 40 **and** beating the current passed default.
- **Rollback:** move the `default` alias (RUNBOOK §3), or set `forecaster = persistence`. A batch run whose output can't fill all three horizons falls back to persistence automatically for that run.
