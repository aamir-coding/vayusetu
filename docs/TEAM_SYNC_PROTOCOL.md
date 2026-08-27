# VayuSetu — 30-Day Context Sync Protocol
> This file is for the 4 of you, not for Claude's Project Knowledge. Keep it in the repo — e.g. `docs/context/TEAM_SYNC_PROTOCOL.md` or folded into `CONTRIBUTING.md` — since it documents the human process for keeping 4 independent Claude Projects from drifting apart, not build context Claude itself needs.

## The one rule that matters more than the rest of this document
**No one edits a shared reference file directly for re-upload.** Every change to a shared file is a pull request against the real repo, reviewed by that file's steward, merged — and only *then* pulled into each engineer's own Project Knowledge. This is exactly the discipline `API_CONTRACTS.md` already applies to code: a breaking change is a PR that fails loudly in review, not a silent mismatch discovered during demo week. Apply that same discipline to the markdown, not just the TypeScript.

Skip this rule and the failure mode is two engineers silently maintaining two different "canonical" copies of the same contract, each confidently telling Claude something different — worse than not having the file at all.

## Where the real source of truth lives
Commit all 6 numbered files (plus this protocol) to the repo under `docs/context/`. The copies sitting in each of your 4 Claude Projects are **read-only mirrors** of that folder. If your Project Knowledge and `docs/context/` ever disagree, the repo wins, always.

## File ownership — so "can I just edit this" has one answer

| File | Steward | Who else must sign off |
|---|---|---|
| `PRODUCT_SPEC.md` | Whole team | All 4 — scope is locked; treat a change like a scope conversation, not an edit |
| `ARCHITECTURE_OVERVIEW.md` | Engineer 2 | Whoever owns the service whose contract changed |
| `API_CONTRACTS.md` | Engineer 2 | Whoever owns the service consuming the changed type/endpoint |
| `DB_SCHEMA.md` | Engineer 4 (BigQuery) | Engineer 2 for any Firestore collection/index change |
| `AI_PIPELINES.md` | Engineer 3 | Engineer 2 if a schema change affects `alert-service`'s consumption |
| `TEAM_ROLES_AND_REPO_MAP.md` | Whole team | Each engineer edits only their own week-row; structural changes need all 4 |

## The daily loop
Run this every working day, in order. Under 5 minutes unless something actually changed.

1. **Pull, before opening any Claude chat.** Check `00_PROJECT_INDEX.md`'s changelog table in `docs/context/` (or your team channel's pinned thread) for any file flagged changed since your last session. Download the current version(s).
2. **Replace, don't stack.** In your own Claude Project, delete the outdated file from Project Knowledge *first*, then upload the new one. Never leave two versions of the same file sitting in Project Knowledge together — Claude has no way to know which one to trust.
3. **Verify the swap actually landed.** Start a fresh chat in the project and ask Claude to quote the "Steward" line from the file you just replaced. There are documented cases of Claude.ai continuing to reference a deleted file's content for a short window after replacement, especially once a project is large enough to trigger RAG mode. A 10-second check now is cheaper than an hour debugging why Claude invented a field that doesn't exist.
4. **Build.** Work normally for the day.
5. **Don't patch your local copy.** If something in your Claude chat surfaces a needed contract change — a new field, a changed threshold, a new endpoint — do not edit your own uploaded file to match. That desyncs you from the other 3 immediately. Take it to step 6 instead.
6. **Propose the change where the code lives.** Open a PR that updates both the actual code *and* the matching file in `docs/context/`, in the same commit — the doc update is part of that PR's definition of done, not a follow-up chore. Tag the file's steward (table above) as reviewer.
7. **Announce at end of day.** One line in the team channel: which file(s) changed, one sentence on what changed. This is what step 1 checks tomorrow.

## Weekly checkpoint
Aligned with the existing Week 1–4 themes in `TEAM_ROLES_AND_REPO_MAP.md`: before starting each new week's deliverables, spend 10 minutes as a team confirming all 4 Project Knowledge bases match `docs/context/`, file by file — "does yours say Day N too." Cheap insurance against a silent daily-loop miss compounding for a week.

## If you're on a Team or Enterprise Claude plan
Sharing one Project across all 4 of you, instead of running 4 independent ones, would eliminate steps 1–3 and 7 entirely — one upload, everyone sees it immediately. If that's available to you, it's the better setup; this protocol exists specifically to substitute for it when Projects can't be shared.
