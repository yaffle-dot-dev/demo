# Private Beta Readiness

This folder holds the operator-facing material for opening Yaffle to a small
external cohort.

## Launch Model

- Start with concierge onboarding, not self-serve.
- Start with one user per org until shared-member flows are fully tested.
- Require the backend smoke suite to be green before inviting new users.
- Run the browser onboarding smoke test before each new invite batch.

## Minimum Exit Criteria Before First Invites

- `bun run smoke` passes locally and in Depot CI.
- `bun run smoke:browser` passes locally.
- Stripe checkout, webhook, and portal flows are verified in the target env.
- Support channel and operator runbook are live.
- Axiom queries / dashboards for beta watch signals are available.
- First-cohort invite list, owners, and follow-up cadence are defined.

## Current Merge Guardrail

The new Depot workflow at `.depot/workflows/smoke-tests.yml` now runs the smoke
suite on PRs and pushes to `main`.

GitHub required status checks could not be enforced on the current private repo
because the API returned:

> Upgrade to GitHub Pro or make this repository public to enable this feature.

Until that changes, treat a green `Smoke Tests / Run smoke tests` check as a
manual merge requirement.

## Documents In This Folder

- `docs/private-beta/onboarding.md` - friend-facing onboarding script
- `docs/private-beta/operator-runbook.md` - internal support, alerts, and invite flow
