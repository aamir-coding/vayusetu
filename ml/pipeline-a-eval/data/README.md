# Pipeline A eval set

## What goes here

`labels.json` (not checked in -- see `.gitignore` at repo root, or create
your own) holds the ~50 real, hand-labeled citizen photos called for in
`TEAM_ROLES_AND_REPO_MAP.md`'s Week 1 deliverable for Engineer 3. This repo
only ships `labels.example.json` (3 illustrative rows) and the JSON Schema
they must satisfy.

## How to build the set

1. **Get ~50 real or realistic photos.** If you don't have real citizen
   submissions yet, a mix of stock/creative-commons photos matching each
   `sourceClassification` value works for Week 1 -- swap in real citizen
   photos as they start arriving in Week 2. Deliberately include:
   - several examples per classification (not just the easy ones)
   - a good number of `no_visible_pollution` and `indeterminate` cases --
     these are the ones the Week 4 red-team pass will punish you for
     getting wrong (false alarms / missed detections)
   - a few deliberately adversarial shots: indoor photos, close-ups of
     unrelated objects, backlit/golden-hour haze (calibration rule 1),
     screenshots or photos-of-photos
2. **Upload them** to a dev GCS bucket your Vertex AI service account can
   read.
3. **Copy `labels.example.json` to `labels.json`** and fill in one entry
   per photo, following `labels.schema.json`. `contextText` should be
   realistic once you have real monitor/satellite context available --
   until then, `"unknown"` placeholders are fine (calibration rule 5 in
   the prompt is specifically about handling that).
4. From `ml/pipeline-a-eval/`, run:
   ```
   pnpm start
   ```
5. Read the misclassification list. Edit the prompt at
   `packages/gemini-client/src/prompts/pipelineA.ts` (not a copy of it --
   that file is the single source of truth). Re-run. Repeat until you're
   comfortable wiring this into `analysis-service` (Week 2).

## What "done" looks like for this Week 1 task

Not 100% accuracy -- a written sense of *where the prompt still breaks*,
because that's what the Week 4 adversarial pass and `needsHumanReview`
threshold tuning will build on. Keep a short running note (in this
README or a CHANGELOG below) of what you changed in the prompt and why,
each time the eval numbers move.
