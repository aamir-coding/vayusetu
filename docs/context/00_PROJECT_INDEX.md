# VayuSetu — Project Knowledge Index
> Source: `PRD_AND_ARCHITECTURE.md` v1.0 (locked). This is Day 0. Read this file first — it tells you, and Claude, what's here, what's deliberately missing, and whether your copy is current.

## Why this file exists
Project Knowledge is scoped per engineer, and nothing here auto-syncs across the four of us. This index is the map: what each reference file covers, who's allowed to change it, and a changelog so a ten-second glance tells you if you're stale. The full update process lives in `TEAM_SYNC_PROTOCOL.md` in the repo — that file is *not* uploaded here, because it's a process doc for humans, not build context Claude needs.

## Files in this knowledge base

| # | File | Covers | Steward |
|---|---|---|---|
| 01 | `PRODUCT_SPEC.md` | Personas, Features 1–4, multilingual/accessibility rules | Whole team — scope is locked, changes need all 4 to sign off |
| 02 | `ARCHITECTURE_OVERVIEW.md` | System diagram, GCP service map, licensing constraints | Engineer 2 |
| 03 | `API_CONTRACTS.md` | Canonical TS types, all 23 REST endpoints, Pub/Sub events | Engineer 2 |
| 04 | `DB_SCHEMA.md` | Firestore collections/indexes, BigQuery DDL, H3 indexing | Engineer 4 (BigQuery) · Engineer 2 co-signs Firestore changes |
| 05 | `AI_PIPELINES.md` | Gemini Pipelines A–D: system instructions, function schemas | Engineer 3 |
| 06 | `TEAM_ROLES_AND_REPO_MAP.md` | Repo file map, weekly deliverables, DoD, 4-week milestones | Whole team — own your own row |

## What's deliberately excluded, and why
**PRD §1** — concept selection, judging-matrix alignment, the three rejected concepts — is not here. It's persuasive, pitch-facing narrative: valuable exactly once, when someone writes the Week 4 pitch script, and pure noise for the other 29 days of implementation questions. If you need it, attach `docs/PRD_AND_ARCHITECTURE.md` directly to that one chat rather than re-adding it to this knowledge base.

## Staleness changelog
*Append a row every time you replace a file in your own Project Knowledge. Don't edit past rows — this is a log, not a status board. Full row-by-row protocol in `TEAM_SYNC_PROTOCOL.md`.*

| Day | File(s) | What changed | By |
|---|---|---|---|
| 0 | All 6 | Initial extraction from PRD v1.0 | — |
| 32 | 03_API_CONTRACTS.md | + `POST /submissions/upload-url` (24 endpoints); error lists for POST /submissions (+403, +500) and assign (+400); service ownership map incl. analysis/corridors/resources → submission-service | Engineer 2 (Claude) |
| 32 | 04_DB_SCHEMA.md | Canonical corridor ids; deterministic alert ids; new tables h3_cells, monitoring_stations, modeled_aqi, meteorology_forecast; UTC convention; column additions | Engineer 4 role (Claude) |
| 32 | 06_TEAM_ROLES_AND_REPO_MAP.md | Engineer 3 left; see `docs/EXECUTION_PLAN.md` for current ownership | Chirag |

## Ground rules for Claude in this project
- `API_CONTRACTS.md` is the single source of truth for every shared type, endpoint, and event. If a request implies a field, endpoint, or shape that isn't in it, say so explicitly instead of inventing a plausible-looking extension.
- If asked about anything from the excluded §1 material (pitch framing, judging-matrix scoring, why alternatives were rejected), say it isn't in this knowledge base rather than reconstructing it from general familiarity with the product idea.
- Treat each file's "Steward" as the person whose call it is when something is ambiguous or contested — don't silently pick a side in a contract disagreement between two engineers.
