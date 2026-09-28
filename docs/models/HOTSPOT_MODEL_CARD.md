# Model card — Hotspot Confidence Model

| | |
|---|---|
| Registry model | `projects/818188514572/locations/asia-south1/models/4203279021359759360` (`vayusetu-hotspot-confidence`) |
| Live version | **v2** (alias `default`), feature schema `hs-v2`, trained 27 Sep 2026 |
| Type | Vertex AI AutoML Tabular, binary classification (`is_hotspot`: `hotspot` / `normal`), objective maximize-au-prc |
| Owner / state | NCR deployment (`DL`); shared to the National Exchange as `passed` |
| Serving | Vertex batch prediction every 6 h (`hotspot_model_every_hours = 6`), `heuristic-v0` in between (cost); scores **every** res-8 cell in the corridor (35,031 in NCR) |

## What it is for
It gives, for every ~0.7 km² cell each hour, the probability that the spot is a **local pollution hotspot**: much worse than its surroundings right now. It is applied mostly where **no official monitor exists**. That is how the product finds *hidden hotspots* (PRODUCT_SPEC Feature 2): confidence ≥ threshold AND no monitor within 3 km.

It is **not** an AQI estimate, not a source classifier (that is Gemini's Pipeline A on citizen photos), and not a forecast.

## Label
The label is measured and retrospective, and exists only where a monitor exists. A station-hour is `hotspot` when that official CPCB monitor reads **AQI ≥ 201** ("poor" or worse) **and ≥ 50 above the corridor-wide mean of all monitors that hour**. That is a local excess, not a region-wide smog day.
- Ground truth: CPCB station data via OpenAQ v3 (about 2 days behind real time), with station NAQI computed as the max sub-index.
- Base rate: **15%** of station-hours (80,711 of 539,902).

## Features (`core.hotspot_features`, the same function used in training and serving)
| Group | Features | As-of rule |
|---|---|---|
| Satellite (Earth Engine) | S5P NO₂, aerosol index; MAIAC AOD; FIRMS fire count; Sentinel-2 burn scar | D-1 |
| Weather (Weather API / ERA5) | wind speed + direction (sin/cos), temperature, humidity, precipitation | same hour |
| Regional background | corridor mean AQI and station count | D-2 (monitor latency) |
| Citizen evidence | report count and mean severity, last 3 h | last 3 h |
| **Place (new in v2)** | lat, lng; Dynamic World built / crops / trees / bare fractions (12-month mean); VIIRS night lights; WorldPop density | yearly (`land-cover` job) |
| Calendar | IST hour, weekday, month, harvest season, Diwali window | — |

Monitor-proximity columns are **excluded from training**: they are ~0 at every labelled (monitored) cell and would only teach "distance 0 means monitored".

## Evaluation (test split, positive class)
- **Split:** spatial. Whole H3 res-6 regions (~36 km²) of monitors are held out: 51 / 9 / 12 stations for train / validate / test.
- **Why spatial:** the model's job is scoring *places it has never seen labels for*, and with place features a time split would reward memorising "station X runs hot".
- **Window:** 27 Sep 2025 – 27 Sep 2026.

| Metric (hotspot class) | v2 (live) | Random baseline |
|---|---|---|
| **auPRC (the gate, ≥ 0.30)** | **0.550** | 0.15 (base rate) |
| Best-F1 threshold | **0.27** | — |
| F1 / precision / recall at 0.27 | 0.540 / 0.506 / 0.580 | — |

Headline numbers Vertex reports for v2 (auPRC 0.936, auROC 0.938) are **micro-averaged over both classes** and **not** a measure of hotspot detection. See the v1 incident below for why that matters.

**Reading it:** at the tuned threshold, about half of flagged cell-hours are real local hotspots (vs 15% by chance), and the model finds about 58% of them, in regions it never trained on.

## ⚠ v1: promoted on the wrong metric (27 Sep 2026)
- **What happened:** v1 (feature schema `hs-v1`, no place features, week-blocked time split) was **promoted on a micro-averaged auPRC of 0.895**. That is Vertex's top-level metric, dominated by the 85% `normal` class.
- **Its real hotspot-class numbers:**
  - auPRC **0.292**, below the 0.30 gate and barely 2× chance
  - auROC 0.712
  - **recall 0.3% at threshold 0.5**
- **Impact:** none in production. hotspot-service was still running `heuristic-v0`, and v1 never scored a live hour.
- **Fixes:**
  - The promotion gate now reads the **positive-class evaluation slice** (`68157ff`).
  - Every version gets a `vayusetu-gate=passed|failed` label.
  - federation-service publishes only `passed` versions and shares the gate metric next to the headline.
- **Second, related bug (fixed in `a471707`):** when v2 was evaluated, the SDK's `Model.update()` wrote v2's gate labels onto **the version holding `default`**, which was v1 at the time. The Registry therefore showed v1 as `passed / 0.5503 / threshold 0.270`, which was false. The truthful record is `core.model_evaluations`: v1 has a `rejected (correction …)` row with 0.2923.
  - **Corrected on 28 Sep, with approval:** v1 is now `vayusetu-gate=failed`, `gate-value=0_2923`. v2 is unchanged (`passed`, holds `default`).
  - **Still pending:** v1 still carries the stale `vayusetu-threshold=0_270` label. The Registry merges labels on update, so it is overwritten to `none` (RUNBOOK §3, "Relabel a model version").
- **Lesson:** a model's headline metric is not its gate. The gate must be the metric for the decision the product makes, on the class it cares about, on a split that matches deployment (unseen places).

## How scores are used in production
- **Calibration** (`apps/hotspot-service/src/domain/fusion.ts` `calibrate`): the model's probabilities run low (tuned threshold 0.27). Before fusion, each probability is mapped piecewise-linearly so that **0.27 → 0.6**, the product-wide `HIDDEN_MIN_CONFIDENCE` and alert `watch` level. The mapping is monotone, so ranking is unchanged.
  - Model hours and heuristic hours then share one scale for the map, the hidden-hotspot rule, alert severity and the 7-day history.
  - Before this, model hours published an **empty map** (27 Sep: max 0.224 < 0.25 floor).
- **Citizen fusion:** `score = 1 − (1 − p_model)(1 − p_citizen)`, with `p_citizen = min(0.95, 1 − e^(−0.35·n·sev/3))`. Citizen reports raise confidence immediately, through the `analysis.completed` fast path, without waiting for the next model hour.
- **Hidden hotspot:** calibrated score ≥ 0.6 AND no monitor within 3 km.
- **Fallback:** if a batch prediction fails or matches no cells, that run uses `heuristic-v0`, logged in the run summary's `modelVersion`.

## Limitations and risks
- **Extrapolation by design.** Labels exist only at ~75 NCR monitors, and the model is applied to 35k cells, most of them far from any monitor. The spatial test covers 12 held-out stations. That is honest but small, and the confidence interval on 0.55 is wide.
- **Label definition.** "≥ 201 and ≥ 50 above corridor mean" favours winter hotspots. In the monsoon, positives are rare (≈3–4%) and the model mostly abstains, which is correct behaviour but means little evaluation signal there.
- **Satellite gaps.** Clouds (monsoon) and D-1 latency leave satellite features null or stale. AutoML handles the nulls, but predictions lean on place and weather features then.
- **Citizen features are sparse in history**, so the model learns little from them. Citizen evidence enters mainly through fusion (above), which is intentional.
- **NCR only.** Mumbai-Pune has no model of its own. It can import this one through the Exchange (feature schema `hs-v2` must match), but the land-cover and background relationships were learned on the Indo-Gangetic plain. Re-evaluate on MH monitors before activating it there.
- **Fairness and geography.** Monitors are denser in central Delhi, so peri-urban and rural cells (the likeliest *hidden* hotspots, e.g. crop and waste burning) are under-represented in labels. Expect weaker recall there, and treat hidden-hotspot alerts as prompts for inspection, not verdicts.

## Retraining
`python -m vayusetu_ml run hotspot` (Vertex AI Pipelines: build training table → AutoML → evaluate_and_promote), which costs about ₹2–4k per run and needs approval. A new version gets `default` only if it passes the gate **and** beats the current passed default. Every evaluation is appended to `core.model_evaluations`.
