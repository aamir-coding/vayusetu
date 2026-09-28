# Models — evaluation summary

VayuSetu runs two trained models and three Gemini pipelines. The trained models:

| Model | Card | Live version | Gate | Test result | Baseline on the same test |
|---|---|---|---|---|---|
| Hotspot Confidence (AutoML Tabular) | [HOTSPOT_MODEL_CARD.md](HOTSPOT_MODEL_CARD.md) | v2, `hs-v2` | positive-class auPRC ≥ 0.30 | **0.550** (spatial holdout) | 0.15 (chance = base rate) |
| AQI Forecast (AutoML Forecasting) | [FORECAST_MODEL_CARD.md](FORECAST_MODEL_CARD.md) | v1, `fc-v2` | MAPE ≤ 40 | **22.7** | persistence 23.8 (D+1 18.0, D+3 28.3) |

The Gemini pipelines (A: citizen photo triage, B: voice, C: official briefings, D: clarifying questions) are prompt-and-schema systems, not trained models. They are documented in `docs/context/05_AI_PIPELINES.md`, and Pipeline A is stress-tested by the red-team set in `packages/gemini-client/redteam/` (27 cases; it found and fixed 3 weaknesses: steam, fog, unsafe reassurance).

## What we learned evaluating them
1. **Gate on the decision, not the headline.** Hotspot v1 was promoted on Vertex's micro-averaged auPRC (0.895), while the hotspot class scored 0.292. The gate now reads the positive-class slice. See the hotspot card, "v1".
2. **Split the way the model is used.**
   - A chronological tail put the hotspot test set entirely in the monsoon (3.8% positives vs 19%).
   - Week blocks fixed the seasons.
   - v2, which has place features, needed a **spatial** holdout, because it is used on places without monitors.
   - Forecasting keeps a chronological split, because it is used on the future.
3. **Always report the naive baseline.** The forecast model's gain over persistence is modest in the monsoon test window. That is in the card, not hidden.
4. **One scale in production.** Model probabilities are calibrated onto the heuristic's confidence scale (tuned threshold → 0.6), so the map, hidden hotspots and alerts don't change meaning when the scorer changes.

## Open items
- Relabel hotspot v1 in the Model Registry (it shows v2's gate labels because of an SDK bug, now fixed). This needs approval because it overwrites metadata.
- Re-evaluate both models on the first weeks of the Oct–Jan smog season.
- Mumbai-Pune: evaluate the NCR models on MH monitors before importing them through the Exchange.
