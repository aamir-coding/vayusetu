# VayuSetu — Gemini AI Pipelines
> Source: PRD §3.3 · Steward: Engineer 3

Four distinct Gemini workflows, deliberately split by volume/latency profile (cheap-and-fast vs. deep-and-grounded) rather than one model for everything.

## Pipeline A — Citizen Report Multimodal Triage
**Model:** Gemini 3.7 Flash, via Vertex AI · **Trigger:** Pub/Sub `submission.created` · **Volume:** highest in the system (one call per citizen submission)

**Input assembly:** submitted photo (inline, GCS URI reference) + voice-note transcript if present (Cloud Speech-to-Text) + a short structured context block — nearest official monitor ID + current AQI, satellite aerosol index for the submission's H3 cell, local time of day, season — injected as text alongside the image.

**System instruction:**
```text
You are the Environmental Field Analyst inside VayuSetu, an air-quality
early-warning system for Indian cities. A citizen has submitted a photo
(and optionally a short voice transcript) reporting something they
believe is affecting local air quality.

Your job: analyze the photo and any provided context, then call the
record_air_quality_assessment function with your structured findings.
Never respond in free text -- always respond via the function call.

Classification taxonomy (choose exactly one for sourceClassification):
- crop_residue_burning: open agricultural field burning, visible ash/stubble
- industrial_emission: smoke/plume from a factory stack or industrial unit
- open_waste_burning: burning garbage/plastic, typically roadside or dump sites
- vehicular_smog: haze consistent with traffic congestion, not a point source
- construction_dust: dust plumes from construction/demolition activity
- no_visible_pollution: clear sky, no evidence of the above
- indeterminate: image does not contain enough information to classify

Calibration rules:
1. Judge haze/opacity relative to what is visible in the background
   (buildings, horizon, sky). Backlit or golden-hour photos often look
   hazier than they are -- account for lighting before scoring severity.
2. If the photo is indoors, a close-up of an unrelated object, or
   otherwise not evidence of ambient outdoor air, classify as
   indeterminate and set confidenceScore below 0.3.
3. skyOpacityScore is 0 (crystal clear) to 1 (opaque / near-zero visibility).
4. visibilityMeters is your best estimate of how far a clear line of
   sight extends in the image; anchor the estimate against known
   reference objects (buildings, trees, road length) when present.
5. You are given the nearest official monitor's current AQI and the
   satellite aerosol index for this grid cell as CONTEXT ONLY -- use
   them to sanity-check, but classify primarily from what you see. If
   your visual assessment and the provided context disagree by more
   than two AQI categories, set needsHumanReview to true and explain
   why in reviewNote.
6. Never invent details not visible in the image. Prefer a lower
   confidenceScore over a confident-sounding guess.
7. Write recommendedAdvisory as one or two short, plain-language
   sentences a non-expert can act on immediately (e.g. "Avoid outdoor
   exercise near this location for the next few hours"), in the
   language given by advisoryLanguage.
```

**Function calling schema:**
```json
{
  "name": "record_air_quality_assessment",
  "description": "Records a structured environmental assessment of a citizen-submitted photo/voice report.",
  "parameters": {
    "type": "object",
    "properties": {
      "sourceClassification": {
        "type": "string",
        "enum": [
          "crop_residue_burning", "industrial_emission", "open_waste_burning",
          "vehicular_smog", "construction_dust", "no_visible_pollution", "indeterminate"
        ]
      },
      "severityEstimate": { "type": "integer", "minimum": 1, "maximum": 5 },
      "skyOpacityScore": { "type": "number", "minimum": 0, "maximum": 1 },
      "plumeDetected": { "type": "boolean" },
      "visibilityMeters": { "type": "number", "minimum": 0 },
      "confidenceScore": { "type": "number", "minimum": 0, "maximum": 1 },
      "needsHumanReview": { "type": "boolean" },
      "reviewNote": { "type": "string" },
      "recommendedAdvisory": { "type": "string" },
      "advisoryLanguage": {
        "type": "string",
        "description": "BCP-47 tag, e.g. hi-IN, pa-IN, mr-IN, en-IN"
      }
    },
    "required": [
      "sourceClassification", "severityEstimate", "skyOpacityScore",
      "plumeDetected", "confidenceScore", "needsHumanReview",
      "recommendedAdvisory", "advisoryLanguage"
    ]
  }
}
```

**Output handling:** `analysis-service` validates returned arguments against this same schema (via Zod, server-side — never trust the model's structural compliance blindly), computes `crossValidation.agreementScore` against the reference context, sets `estimatedAQICategory`, persists the `AnalysisResult`, archives the full raw model response to Cloud Storage for audit, publishes `analysis.completed`.

## Pipeline B — Advisory Localization & Text-to-Speech
Piggybacks on Pipeline A's output: `recommendedAdvisory` is already generated directly in the citizen's `preferredLanguage` (passed as `advisoryLanguage` in the request), so no separate translation call is needed. Cloud Text-to-Speech synthesizes the advisory to audio, cached in Cloud Storage keyed by a hash of `text + language + voice` — repeated identical advisories in the same language are never re-synthesized.

## Pipeline C — Hotspot / Forecast Alert Briefing
**Model:** Gemini 3.1 Pro, via Vertex AI · **Trigger:** `hotspot.updated` or `forecast.updated` crossing a configured severity threshold · **Volume:** low, per-alert not per-submission — deliberately the more expensive, deeper-reasoning model, since a bad official-facing briefing costs far more than a slightly-off citizen advisory.

**System instruction:**
```text
You are a Senior Environmental Policy Analyst drafting a briefing for a
District Magistrate or State Pollution Control Board officer inside
VayuSetu. You will be given structured, already-computed data: a
hotspot or forecast event, its contributing signals, the corridor's
configured GRAP/CAQM stage thresholds, and recent history for context.

Ground every sentence in the provided data. Do not introduce facts,
locations, or figures that are not present in the input. Call
draft_alert_briefing with your output; never respond in free text.

- title: <= 12 words, states what is happening and where.
- description: 2-4 sentences, explicitly cites which signals triggered
  this (e.g. "citizen reports up 4x in the last 3 hours; satellite NO2
  column 2.1x the 30-day median for this cell").
- impliedGrapStage: map the data to the corridor's configured stage
  thresholds, supplied to you in the input; use "none" if no stage
  applies. Never invent a threshold that was not supplied to you.
- recommendedActions: 2-4 ranked interventions grounded in standard
  GRAP/CAQM playbooks (e.g. water sprinkling, construction pause,
  mechanized road sweeping, restricting non-essential diesel vehicles).
- publicAdvisory: one plain-language sentence safe to push to citizens
  in the affected corridor.
- citedSignals: list which specific input fields you relied on, for
  the audit trail an official may need to justify action taken.
```

**Function calling schema:**
```json
{
  "name": "draft_alert_briefing",
  "description": "Produces a grounded, structured alert briefing for an official dashboard from pre-computed hotspot/forecast data.",
  "parameters": {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "description": { "type": "string" },
      "impliedGrapStage": {
        "type": "string",
        "enum": ["none", "stage_1", "stage_2", "stage_3", "stage_4"]
      },
      "recommendedActions": {
        "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 4
      },
      "publicAdvisory": { "type": "string" },
      "citedSignals": { "type": "array", "items": { "type": "string" } }
    },
    "required": [
      "title", "description", "impliedGrapStage",
      "recommendedActions", "publicAdvisory", "citedSignals"
    ]
  }
}
```

**Deliberate design note — don't "fix" this:** `severity` is absent from this schema on purpose. `alert-service` computes severity deterministically from the underlying hotspot/forecast numbers *before* calling Gemini, and passes it in as context. The model is never asked to decide how urgent its own briefing is — only how to explain an urgency the system already determined.

## Pipeline D — Conversational Clarification (bounded, multi-turn)
Used within the PWA's guided voice-reporting mode (and, Phase 2, the IVR hotline). When Pipeline A's `confidenceScore` falls below threshold and `sourceClassification` is `indeterminate`, Gemini 3.7 Flash gets one follow-up turn to ask a single clarifying question (e.g., "I can see smoke but can't tell if it's a factory or a field — can you point the camera a bit further away?"), capped at **two turns maximum** (respect low-literacy/low-patience users), with a graceful fallback ("recorded as unclassified, will be reviewed") if the citizen doesn't respond. Reuses Pipeline A's function schema rather than introducing a new one — the exchange either produces a completed `record_air_quality_assessment` call or terminates into the fallback state.

**Implementation (26 Sep 2026):** in clarification mode the model is given Pipeline A's instruction plus a short addendum and **two** allowed functions: the unchanged `record_air_quality_assessment`, and `ask_clarifying_question { question, language }`, which is the only way the model can produce the follow-up question. The question is stored on `Submission.clarifications[]` and surfaced as `AnalysisResult.pendingClarification`. The citizen answers via `POST /submissions/:id/clarify` (text and/or one more photo), which re-runs the pipeline with the whole exchange as context. After two turns, or with no answer, the report stays `needsHumanReview` with reviewNote "Recorded as unclassified; will be reviewed." Code: `packages/gemini-client/src/pipelineD.ts`.

## Deployment notes (verified live, 26 Sep 2026)

| Pipeline | Service | Model / API | Location | Env override |
|---|---|---|---|---|
| A, D | Vertex AI Gemini | `gemini-3.7-flash` | `global` | `GEMINI_TRIAGE_MODEL`, `GEMINI_LOCATION` |
| C | Vertex AI Gemini | `gemini-3.1-pro-preview` (no GA `gemini-3.1-pro` id yet) | `global` | `GEMINI_BRIEFING_MODEL` |
| A (voice in) | Cloud Speech-to-Text v2 | `chirp_3` | `us` | `STT_MODEL`, `STT_LOCATION` |
| B (voice out) | Cloud Text-to-Speech | `<lang>-Chirp3-HD-Aoede` | global | `TTS_VOICE_NAME` |

- **Data residency:** none of these models answers in `asia-south1` today (Gemini 404s there; Speech has no Indic model there). Only the photo URI or audio bytes and the derived context block are sent; nothing is stored outside the project. Move each to an India region as soon as Model Garden or Speech lists one there. This is a config change, not a deploy.
- **Punjabi speech** must be requested as `pa-Guru-IN` (Cloud Speech's code); `pa-IN` is rejected. `chirp_2` garbles Punjabi and Marathi, so do not use it as a fallback.
- **Measured latency:**
  - Pipeline A: about 7.7 s for a 2019 Delhi smog photo, classified correctly as `vehicular_smog` with a Hindi advisory.
  - Pipeline C: about 18 s for a hotspot briefing.
- **Pipeline C citation grounding:** Gemini tends to cite leaf names (`citizenReportCount`). alert-service expands a leaf to its unique full path (the shallowest match wins) instead of dropping it from the audit trail.

