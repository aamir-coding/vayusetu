# VayuSetu — Demo script (8 minutes)

Live system: NCR (`vayusetu-ncr-dev`). The second state is Mumbai-Pune (`vayusetu-mh-dev`), and the National Exchange is `vayusetu-exchange-dev`. Every step below was rehearsed on the live system on 27–28 Sep 2026 (§5).

## 1. Cast and screens
**Front door: https://vayusetu.web.app.** It has one link per state and role; open it first on the projector, then click through.

| Who | Device | URL | Account |
|---|---|---|---|
| **Rina**, citizen (Hindi) | phone, or Chrome mobile emulation | https://vayusetu-ncr-dev.web.app | anonymous (automatic) |
| second and **third** citizen | two more phones, or two more browser profiles | same | anonymous; each profile is a distinct citizen |
| **Officer Deshmukh**, district admin | laptop window 1 | https://vayusetu-ncr-dev-admin.web.app | `district_admin@vayu.com` |
| **Ms. Iyer**, state admin | laptop window 2 (separate profile) | same | `state_admin@vayu.com` |

Chirag signs in to the admin accounts; nobody else handles those passwords.

## 2. Pre-flight (T−30 min)
1. **Warm the services**, because every service scales to zero and a cold start adds ~10 s. Open the admin console on each screen (Alerts, Hotspot Map, Forecast, Federation) and the citizen PWA once.
2. **Data is fresh.**
   ```bash
   gcloud run jobs executions list --project vayusetu-ncr-dev --region asia-south1 --limit 8
   ```
   The newest `hotspot-score-hourly` and `forecast-score` runs should have succeeded within the last hour and 6 hours. The Forecast view shows `model projects/…/models/…@1`.
3. **Monitoring is clean.** The dashboard "VayuSetu ncr-dev — operations" (once `monitoring.tf` is applied) shows no open incidents. Billing must be enabled (see RUNBOOK "429 / billing").
4. **Two report photos** on the phone, both of the **same spot**, e.g. roadside garbage burning. `packages/gemini-client/redteam/images/garbage_fire.jpg` works if you have no real one.
5. **Location: Karol Bagh, 28.65041, 77.19009** (type it manually: Report → Change → Latitude/Longitude). This is the centre of H3 cell `883da11623fffff`, inside **DL-CENTRAL**, Deshmukh's district. Alerts are routed by the district of the cell's *centre*. Do **not** use Anand Vihar: that cell straddles the Delhi–UP border, and its alert went to UP-GHAZIABAD, which neither demo account can see (28 Sep rehearsal).
6. **Notifications:** in Deshmukh's window, click "Enable alert notifications" (needs the VAPID key; without it, the live queue still updates via Firestore).

## 3. Script
| Time | Beat | What to show | What to say |
|---|---|---|---|
| 0:00 | Problem | the Hotspot Map | "Delhi has ~40 official monitors for 1,500 km². Pollution sources — a garbage fire, stubble, a construction site — sit between them. Officials learn late, citizens have no voice." |
| 0:40 | Citizen report | PWA → switch to **हिन्दी** → take photo → Send | "Rina photographs a fire. No typing, in her language." |
| 1:10 | Gemini triage | result card: **Open waste burning, severity 4**, Hindi advisory, ▶ **audio** | "Gemini 3.7 Flash on Vertex AI classifies the source, estimates severity and visibility, and writes advice in Hindi; Cloud TTS reads it aloud. It cross-checks the nearest monitor and satellite aerosol, and flags disagreement for an official." |
| 2:00 | Second citizen | a **second phone/profile** sends a photo from the same spot | "A second, independent citizen reports the same spot…" |
| 2:20 | Hotspot fusion | admin **Hotspot Map**: the cell turns red, amber outline if hidden; click → signals + 7-day history | "…pushes this 0.7 km² cell over the alert line. The Hotspot Fusion Engine fuses citizen evidence with an AutoML model over satellite (Sentinel-5P, MODIS, FIRMS via Earth Engine), weather and land-cover features — and flags *hidden* hotspots, far from any monitor." |
| 3:10 | Live alert | **Alert Queue**: new alert toasts in live (and a push, if enabled) → open it | "The alert arrives in real time, routed only to the officer whose district contains it. Gemini 3.1 Pro wrote the briefing, with every claim cited to a signal." |
| 3:50 | Action | Acknowledge → In progress; the audit trail grows | "Every status change is audited; officials can't edit alerts behind the API." |
| 4:10 | Forecast | **Forecast** view: 72 h trajectory, band, GRAP stages, key drivers | "Vertex AutoML Forecasting predicts the next three days for the corridor, with an uncertainty band and the GRAP stage it implies — so restrictions can start before the peak." |
| 5:00 | Federation | switch to **Ms. Iyer** → **Federation** → Cross-state View → Shared Models | "NCR spans four states. Each state runs its own project — data never leaves it. They share k-anonymised weekly summaries and trained models through a National Exchange. Mumbai-Pune runs from the same Terraform module; it can import NCR's model — but only a super_admin can." |
| 6:10 | Inclusion | admin language switch → हिन्दी; **Lite Mode** | "Every screen in Hindi, Punjabi, Marathi and English — generated with Cloud Translation and reviewed. Lite mode for 2G connections." |
| 6:40 | Trust | slide: red-team + model cards | "We red-teamed Gemini with 27 adversarial cases — prompt injections hidden *inside photos*, steam that looks like smoke, requests for medicine doses — and fixed what we found. Our model cards report the honest baselines, including a model we had to reject." |
| 7:20 | Google stack | architecture slide | Gemini (Flash, Pro, image) · Vertex AI AutoML + Pipelines + Model Registry · Earth Engine · BigQuery · Cloud Run + Jobs + Scheduler · Pub/Sub · Firestore · Firebase Hosting/Auth/FCM · Maps JS, Air Quality, Weather, Geocoding · Speech-to-Text, Text-to-Speech, Translation · Cloud Monitoring |
| 8:00 | End | | |

## 4. Why two, and sometimes three, citizens (the maths, so nobody is surprised)
Alerts fire when a cell's fused confidence crosses **0.6**. Citizen evidence is `p = 1 − e^(−0.35·n·s/3)`, where **n = distinct citizens** (one vote each) and **s = their average severity**:
- one severity-4 citizen ≈ 0.37
- **two** at severity 4 ≈ 0.61, which alerts on its own
- two at 4 and 3 (s = 3.5) ≈ 0.56, which does **not** alert unless the model already rates the cell ≥ 0.1
- **three** at 3.5 ≈ 0.71

The fused score is `1 − (1 − p_model)(1 − p_citizen)`. Between the 6-hourly model runs the model score of a quiet cell is ~0.02, so it adds almost nothing. Gemini rated the *same* photo 4 and then 3 in rehearsal. **So:** send the second report from a second phone or profile; if the cell hasn't turned red ~20 s after its result card appears, send the third. The same phone re-reporting counts once, which is the anti-spam rule.

**A report counts** when Gemini is confident (≥ 0.5) and either:
- it shows a **visible plume from a point source** (fire, stubble, stack, dust) at confidence ≥ 0.8, *even if the nearest monitor disagrees* (that disagreement is what makes it a hidden hotspot, and the report still goes to officials for review); or
- for diffuse haze, the photo agrees with the monitor/modeled AQI (agreement ≥ 0.4).

## 5. Rehearsal log (27–28 Sep 2026, live NCR)
Four blocking bugs were found and fixed; before these fixes, the citizen flow could not work on the deployed site:
1. **Upload blocked by CORS:** the bucket allowed only localhost. Fixed in `storage.tf` and applied to both buckets.
2. **Stale cached 404 for `/users/me`:** the service worker cached per-user API responses, which blocked registration and was also a privacy leak. Now only reference data is cached.
3. **Result screen stopped polling on `queued`:** a cold start meant the first poll saw `queued`. Fixed, with an E2E regression test.
4. **Deep link to a result before the session restored:** it showed "couldn't be analyzed". `getToken()` now waits for the session.

The first live report after fix 1 was analysed in 24 s (12 s of it a cold start):
- open waste burning, severity 4, confidence 0.95
- English advisory with Cloud TTS audio
- correctly **flagged for review**, because the photo looked "severe" while the modeled AQI was 64

This rehearsal also exposed a design flaw. That flagged fire could **never** move the heatmap, because disagreeing with a distant monitor disqualified it, which is exactly the hidden hotspot the product exists to find. The fast path now counts visible point-source plumes, and counts distinct citizens instead of reports.

## 6. If something goes wrong
| Symptom | Do |
|---|---|
| Result spins > 30 s | Cold start; wait, or show the report from My Reports. The warm-up in §2 prevents it. |
| Report says "flagged for review" | That's a feature: say "Gemini and the monitor disagree, so a human decides". It still reaches officials. |
| No alert after two reports | Average severity came out under 4 (§4): send the third citizen. Or both came from one device (counts once), or a report had no visible plume. Fallback: open an existing alert from the queue. |
| Alert created but not in Deshmukh's queue | The cell's centre is in another district (§2.5): use the Karol Bagh coordinates. Ms. Iyer (state admin) sees every DL district. |
| Admin shows 429 / nothing loads | Billing: RUNBOOK "429 / billing". Fallback: the local mock demo, `pnpm --filter @vayusetu/admin-dashboard dev` + `pnpm --filter @vayusetu/citizen-pwa dev`, where every screen works offline with fixtures. |
| Map is empty | The hourly scorer hasn't run: `gcloud run jobs execute hotspot-score-hourly-ncr-dev --region asia-south1`. |
