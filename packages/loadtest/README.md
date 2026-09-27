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

## Verified
- `node --test lib.test.mjs`: percentiles, weighted mix, limiter-breach planning, verdicts.
- All three scenarios ran end to end against a local stub API (including a per-user 429). Only Chirag runs them against the live URLs.
