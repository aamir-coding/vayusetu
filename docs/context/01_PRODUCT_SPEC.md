# VayuSetu — Product Spec
> Source: PRD §2 (Product Requirements) · Status: locked, no open questions · Steward: whole team, unanimous sign-off to change

## Personas — design against these, don't invent new ones

**Rina — Citizen Reporter.** Peri-urban NCR/Mumbai-Pune, mid-range Android, prepaid data, not necessarily English-fluent. Wants to report what she sees in under 30 seconds, get an immediate plain-language "is it safe right now," and feel the report did something.
*Needs: near-zero-friction capture, voice in her own language, no login wall blocking a first report.*

**Anand — Frontline Field Worker.** NGO/SPCB contractor, sometimes carries a handheld sensor, systematically covers monitor-blind areas. Semi-power-user; his photos anchor the Hotspot Fusion Engine's confidence in new areas.
*Needs: batch/systematic reporting, attach a sensor reading alongside a photo, a personal trend dashboard for "his" area, offline queueing.*

**Officer Deshmukh — District Administrator / SPCB Field Officer.** Owns a district's pollution response — inspection dispatch, advisories, GRAP-linked interventions. Her failure mode isn't too little data, it's an alert she can't tell is real in the 15 seconds she has to triage it.
*Needs: jurisdiction-filtered alert queue (her district only), one-glance severity + recommended action, one-tap status update, a defensible audit trail.*

**Ms. Iyer — State Climate Resilience Cell Director.** Cross-district view, resource-allocation authority, the persona who cares about the Federation Exchange — she's deciding whether her state's political capital is well spent on a system that also helps (and learns from) neighboring states.
*Needs: corridor-level forecast view, cross-state resource-request visibility, confidence her state's raw data stays inside her state's control.*

## Feature 1 — "Snap & Sense": Multimodal Citizen Reporting
*As Rina: photograph pollution near me, understand immediately if it's dangerous, without typing, in Hindi.*

- **Inputs:** camera photo (required) · optional 10s voice note · device GPS, required, manual pin-drop fallback if denied · optional PM2.5/PM10 sensor reading (Persona 2 only).
- **Flow:** submit → photo/voice to Cloud Storage, `Submission` written to Firestore (`status: 'queued'`) → Firestore trigger publishes `submission.created` → `analysis-service` resolves `h3Index`/`jurisdiction`, pulls nearest monitor reading + satellite aerosol index as context, transcribes any voice note, calls **Gemini 3.7 Flash** under the `record_air_quality_assessment` schema (full prompt in `AI_PIPELINES.md`) → result cross-validated, written as `AnalysisResult`; folds into the hourly aggregate feeding Feature 2 only if `confidenceScore` + cross-validation agreement clear a configured threshold.
- **Output:** "Air Snapshot" card — source + severity + one-line advisory, text + synthesized audio in the citizen's language, typically 4–8s after submission.

## Feature 2 — "Hotspot Fusion Engine" (The Detector)
*As Officer Deshmukh: know about pollution events even in unmonitored neighborhoods, before a complaint escalates.*

- **Inputs:** rolling hourly citizen `AnalysisResult` aggregates per H3 cell · satellite (Sentinel-5P NO₂/aerosol, VIIRS/MODIS fire, Sentinel-2 burn-scar) · IMD meteorology (wind, boundary-layer height, temp, humidity) · CPCB/SPCB monitor readings as calibration ground truth.
- **Flow:** hourly, `hotspot-service` joins all four signal families on `(h3Index, hour)`, scores every cell with the Hotspot Confidence Model (AutoML Tabular), flags `isHidden: true` when confidence is high **and** no official monitor exists within a configured radius (default 3 km) — this is the literal, auditable definition of "hidden hotspot."
- **Output:** updated `HotspotCell` grid per corridor → live heatmap → `hotspot.updated` event to Alert Service.

## Feature 3 — "72-Hour Forecast & GRAP-Style Escalation" (The Forecaster)
*As Ms. Iyer: know 2–3 days ahead that my corridor is heading into a severe-AQI window, with lead time to pre-position resources.*

- **Inputs:** corridor AQI history · IMD short-range forecast · seasonal-burning calendar (Punjab/Haryana harvest windows) · festival/traffic calendar (Diwali).
- **Flow:** every 6h, `forecast-service` scores each active corridor across 24/48/72h horizons (AutoML Forecasting). A horizon point crossing the corridor's configured GRAP/CAQM threshold triggers `forecast.updated` → Alert Service → **Gemini 3.1 Pro** drafts a grounded briefing (prompt in `AI_PIPELINES.md`): title, description, implied GRAP stage, 2–4 ranked interventions, citizen-safe public advisory, all traceable to the signals that justified them.
- **Output:** corridor forecast chart + threshold-crossing `Alert` with full audit trail.

## Feature 4 — "The Bridge": Federated Model & Resource Exchange
*As Ms. Iyer: benefit from what Delhi and Haryana already learned, without a single citizen photo leaving my state's cloud project.*

- **Inputs:** each state's locally trained model artifacts (Vertex AI Model Registry) + k-anonymized, coarsened hotspot aggregates (published only above a minimum underlying report count, at a lower H3 resolution than the operational grid).
- **Flow:** nightly, `federation-service` exports local model version + performance metrics + aggregate stats to the shared National Exchange, and pulls other states' shared versions for `super_admin` review/import. Corridors spanning state lines (NCR spans Delhi/Haryana/UP/Rajasthan) get a cross-state aggregated hotspot view.
- **Output:** "Federation" panel (state_admin+): available shared models, one-click import, Resource Coordination Board.
- **Scope honesty, stated so nobody over-claims it in the pitch:** this is federated *model and insight* sharing — batch export/import of trained artifacts and aggregates — **not** cryptographic federated learning with secure gradient aggregation. That hardening is the flagged Phase 2 step.

## Multilingual & Accessibility Rules
- **Voice-in:** Cloud Speech-to-Text transcribes citizen voice notes (Hindi, English, Punjabi, Marathi; Haryanvi handled as a Hindi dialect variant).
- **Voice-out:** every advisory/alert gets a cached Cloud TTS (Neural2/Chirp) rendering.
- **Division of labor — don't blur this line:** Gemini generates dynamic, per-event content directly in `preferredLanguage` (never English-then-translate — translated dynamic content reads worse). Cloud Translation API handles static, cacheable UI strings only.
- **Language switching:** single persistent control, stored on `User.preferredLanguage`, no re-login required.
- **Low-bandwidth:** Citizen PWA is offline-capable (Workbox + IndexedDB queue, syncs on reconnect); photo uploads client-compressed, quality auto-scaled on 2G/3G; Admin Dashboard has a "Lite Mode" plain-table fallback.
- **Phase 2, explicitly not in the 30-day core scope:** IVR hotline via Vertex AI Agent Builder (the current product name for what the brief calls "Dialogflow") + Speech-to-Text, for feature-phone reporting. Excluded because it needs a telephony/carrier integration outside the GCP stack — architected for, not built now. Don't let this creep into a Week 1–4 deliverable.
