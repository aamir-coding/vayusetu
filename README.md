# VayuSetu

Federated, AI-powered air-quality early-warning platform for hyperlocal pollution detection and forecasting. Built for the Google Cloud Hackathon, Track B: Clean Air & Climate Resilience.

Full product/architecture context lives in `docs/context/` (see `00_PROJECT_INDEX.md` first) and `docs/PRD_AND_ARCHITECTURE.md`.

## Quickstart

```bash
corepack enable
pnpm install
pnpm dev            # runs every app's dev script in parallel via turbo
```

- Citizen PWA: http://localhost:5173
- Admin Dashboard: http://localhost:5174

**No environment variables are required to run either app.** Both ship in mock mode by default: [MSW](https://mswjs.io) intercepts every REST call against the exact shapes in `API_CONTRACTS.md`, and Firebase Auth is replaced by an in-memory/localStorage stand-in (see each app's `.env.example` and `src/lib/firebase.ts`). This is deliberate — Engineer 1's frontend work is never blocked on the other three engineers' services landing.

- **Citizen PWA**: opens straight into report capture, no login wall (silent anonymous auth). Tap **Verify** in the header to try the phone-OTP flow — mock OTP is `123456`.
- **Admin Dashboard**: sign-in screen offers two personas — Officer Deshmukh (district_admin) and Ms. Iyer (state_admin) — since real accounts are provisioned out-of-band per the contract, not self-registered.

## What's here

| Path | Owner | Status |
|---|---|---|
| `packages/shared-types` | Engineer 2 | Canonical, byte-identical to `API_CONTRACTS.md` §4.1 |
| `packages/config` | Engineer 1 | Shared Tailwind design tokens (brand, AQI/severity/GRAP color ramps, type scale) |
| `packages/ui-components` | Engineer 1 | shadcn/ui-style component library, typed against `shared-types` |
| `apps/citizen-pwa` | Engineer 1 | Feature 1 (Snap & Sense) — capture, snapshot result, my reports, phone auth, offline queue, 4-language i18n |
| `apps/admin-dashboard` | Engineer 1 | Alert queue, hotspot map, forecast view, Federation panel, Lite Mode |
| `apps/submission-service`, `analysis-service`, `hotspot-service`, `forecast-service`, `alert-service`, `federation-service`, `ingestion-jobs` | Engineers 2–4 | Not yet built |

## Commands

Standard turbo-orchestrated scripts from the repo root: `pnpm build`, `pnpm dev`, `pnpm lint`, `pnpm type-check`, `pnpm format`. Scope any of these to one app with `pnpm --filter @vayusetu/citizen-pwa <script>`.

## Contract gaps found while building the frontend

Flagged in code (search `contract gap` isn't literal — see comments in `apps/citizen-pwa/src/lib/apiClient.ts` and `src/hooks/useAuth.tsx`) rather than silently worked around:

1. **Field-worker sensor reading has nowhere to go.** Product Spec Feature 1 lists an optional PM2.5/PM10 reading as a Persona 2 input, but `POST /submissions`'s request body in `API_CONTRACTS.md` §4.2 doesn't include it. Currently captured client-side and held in the offline-queue shape only; not sent to the server.
2. **`role` can't be changed after registration.** `PATCH /users/me` only allows `displayName` / `preferredLanguage` / `fcmTokens`. A citizen who registers anonymously can't later "become" a field worker through the API as specified — worked around by asking the field-worker question *before* first registration (during phone verification), not by inventing a client-side role upgrade.

Both are one-line additions to `packages/shared-types` if the team wants them — flagging for whoever owns that conversation rather than deciding unilaterally.
