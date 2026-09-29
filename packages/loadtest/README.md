# Load tests (read-only)

`loadtest.mjs` sends **GET requests only**, to the six read endpoints behind the admin Hosting site:
- `/hotspots` and `/hotspots/{h3}/history`
- `/forecasts/{c}/latest` and `/forecasts/{c}/history`
- `/corridors` and `/corridors/{c}`

It never submits, retries, imports or changes status. It has zero dependencies (Node 20+), and it refuses to run above 50 rps or 600 s without `--i-know`.

## 1. Get ID tokens (Chirag, on your machine)
Tokens are yours: the script never prints or stores them. The simplest source is the Firebase Auth REST sign-in for a test account you created. The web API key is the public one shipped in the admin bundle (`frontend-env-admin-dashboard`, `VITE_FIREBASE_API_KEY`):
```bash
curl -s "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$WEB_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"email":"district_admin@vayu.com","password":"<type it here>","returnSecureToken":true}' \
  | python -c "import json,sys; print(json.load(sys.stdin)['idToken'])"
```
Tokens expire after **1 hour**. Use one token per test account (`district_admin@`, `state_admin@`, `super_admin@`) → `TOKENS=t1,t2,t3`.

## 2. Why several tokens
Every service rate-limits **per user** (Firebase uid): 60/min for submission-service and federation-service, and 120/min for the others. A single token sending more than about 1 rps to `/corridors` measures the *limiter*, not capacity. The `steady` scenario computes each token's share per service and refuses plans that would trip it; add tokens or lower `--rps`.

## 3. Run, in this order
```bash
cd packages/loadtest
export TOKENS=<t1>,<t2>,<t3>          # BASE_URL defaults to the NCR admin site
node loadtest.mjs --scenario smoke    # 1 request per endpoint: auth, routing, shapes
node loadtest.mjs --scenario limiter  # 1 token past 60/min: clean 429 RATE_LIMITED, never 5xx
node loadtest.mjs --scenario steady --rps 3 --duration 120   # warm, pilot-level traffic
node loadtest.mjs --scenario steady --rps 6 --duration 180   # 2x; watch cold starts
```
Options:
- `--p95 <ms>` (default 1500)
- `--max-error-rate <0..1>` (default 0.01)
- `BASE_URL=https://vayusetu-mh-dev-admin.web.app/api/v1 CORRIDOR_ID=mumbai-pune-corridor` for Mumbai-Pune
- **Wait 60 s after `limiter`** before a `steady` run: the first token's one-minute allowance is spent.
- The plan check keeps each token under **80%** of every per-user limit, because random arrivals burst over a limit the average only nears. The maximum `--rps` is about 2.7 × the number of tokens: **5** with Mumbai-Pune's two admins, **8** with three.

## 4. Pass criteria
| Scenario | Pass |
|---|---|
| smoke | every endpoint returns 2xx (`hotspot-history` may 404 on an empty grid) |
| limiter | ≥ 15 of 80 requests are 429 with an `ApiError` `RATE_LIMITED` body, and no 5xx |
| steady | per endpoint p95 < 1500 ms and non-2xx < 1% |

The first requests after idle include Cloud Run cold starts (every service scales to zero), which shows up in p99. That's expected for a dev project. `min_instances` in `cloud_run.tf` is the lever for a live demo.

## 5. Cost
- Each request is a Cloud Run invocation.
- `/hotspots/{h3}/history` also runs a small BigQuery query (partition and cluster pruned, about 10 MB billed, roughly ₹0.005 each).
- `/hotspots` and `/forecasts` read Firestore.

A 6 rps × 180 s run is about 1,100 requests: a few rupees. Watch the ops dashboard (`monitoring.tf`, "VayuSetu <env> — operations") while it runs.

## Results: 29 Sep 2026 (run by Chirag from Bengaluru; server-side figures from Cloud Run request logs)
**Services: pass in both states.** There were zero 5xx errors in about 3,060 requests.

**Delhi NCR** (13:21–13:28 UTC, 3 tokens): 1,530 requests, and **every scenario passed**. The terminal output wasn't kept; the figures below are server-side.

| Scenario | Server p95 by endpoint | Status |
|---|---|---|
| smoke | all < 160 ms, except `hotspot-history` 1.0 s | all 200 |
| limiter | — | 21 × 429 `RATE_LIMITED` (≥ 15), no 5xx |
| steady 3 rps | 38–71 ms; `hotspot-history` 1,029 ms | all 200 |
| steady 6 rps | 26–53 ms; `hotspot-history` 1,056 ms | all 200 |

**Mumbai-Pune** (13:38–13:46 UTC, 2 tokens):
- smoke passed. The first requests hit cold starts: hotspot-service 10.4 s, forecast-service 7.7 s.
- limiter passed: 20 × 429, all `RATE_LIMITED`.
- Both steady runs reported FAIL, but none of the failures was the service's:

| Client-side FAIL | Server-side | Cause |
|---|---|---|
| 3 rps: `corridors` 2.7% errors | the 2 errors were 429s | Steady started right after `limiter`, while token 1 was still rate-limited. The tool now tells you to wait 60 s. |
| 6 rps: `corridor` 1.8%, `corridors` 0.9% | 4 × 429 | 54/min per token against a 60/min limit, with random bursts. The plan check now refuses this; use `--rps 5` with 2 tokens. |
| 6 rps: `forecast-history` p95 3,282 ms; p99 of about 4 s on every endpoint | p95 54 ms; slowest non-BigQuery request 173 ms, on one instance per service with no cold start | The network between the laptop, Firebase Hosting and Cloud Run. The baseline was about 270 ms per request, plus transient multi-second spikes. |
| 3 and 6 rps: `hotspot-history` p95 1,526 / 2,292 ms | p95 1,064 / 1,124 ms | **The one real hotspot.** It runs a BigQuery query per call, and about 300 ms of network puts it at the 1.5 s bar. The lever: cache the 24 h history per cell for a few minutes, since it changes hourly. |

**Mumbai-Pune re-run** (same day, after both fixes: `hotspot-history` cached in `1457b3b`, and a 60 s wait after `limiter`): **all four scenarios pass**, with zero errors in 1,260 steady requests.

| Scenario | Client-side p95 by endpoint | Status |
|---|---|---|
| smoke | cold start: `forecast-latest` 9.0 s (warm-up covers it) | all 200 |
| limiter | — | 21 × 429 `RATE_LIMITED`, no 5xx |
| steady 3 rps | 421–637 ms; `hotspot-history` **637 ms** (was 1,526) | all 200 |
| steady 5 rps | 463–581 ms; `hotspot-history` **517 ms** (was 2,292 at 6 rps) | all 200 |

**Demo takeaways:**
- The warm-up in `docs/DEMO.md` §2 matters. A cold hotspot or forecast service takes 8–10 s on its first request; `min_instances = 1` removes that, at a cost.
- Pilot-level load (3–6 rps) is far below capacity: every service ran on a single instance.

## Verified
- `node --test lib.test.mjs`: percentiles, weighted mix, limiter-breach planning, verdicts.
- All three scenarios ran end to end against a local stub API (including a per-user 429). Only Chirag runs them against the live URLs.
