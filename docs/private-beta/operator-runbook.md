# Private Beta Operator Runbook

This is the internal checklist for admitting, supporting, and monitoring the
first external beta cohort.

## Before Inviting Anyone

1. Confirm `bun run smoke` is green locally and in Depot CI.
2. Confirm `bun run smoke:browser` is green locally.
3. Verify Stripe config in the target environment.
4. Verify provider discovery agent health.
5. Verify the support channel owner for the day.

## First-Cohort Invite Flow

1. Pick 3-5 trusted users with one repo each.
2. Track them in Linear under the private beta smoke testing project or a follow-up beta ops project.
3. Send the onboarding message from `docs/private-beta/onboarding.md`.
4. Ask each user to schedule or start with a single repo and a single PR.
5. Stay online while the first PR is opened.
6. Record outcome after the session:
   - signed in successfully
   - org created
   - GitHub App installed
   - repo linked
   - preview created
   - preview cleaned up
   - billing touched or skipped
   - provider discovery touched or skipped

## Support Triage

When a beta user reports a problem, collect:

- org slug
- repo name
- PR number or branch name
- approximate timestamp
- screenshot / exact page
- whether the issue is blocking or cosmetic

Then check, in order:

1. org creation / provisioning status
2. GitHub App installation and repo mapping
3. preview run / job state
4. billing state if the block is plan-related
5. provider discovery dispatch or callback state if missing credentials are involved

## Beta Watch Alerts

Use `docs/observability.md` as the query reference. For beta, watch these first:

- webhook ingest failures or missing deliveries
- jobs stuck in queue or stale timeout events
- org provisioning failures or long-lived provisioning states
- Stripe webhook signature failures and payment failure events
- provider discovery dispatch failures
- provider discovery callback auth failures or replay detections
- preview cleanup failures after PR close / merge

## Manual Fallbacks

- Onboarding blocked: stay concierge, complete setup with the user live.
- Billing blocked: keep the org on free/manual access until the billing bug is fixed.
- Provider discovery blocked: capture the missing env vars manually and create the connection without discovery.
- Cleanup blocked: manually verify state and resource cleanup before inviting the next user.

## Daily Beta Cadence

- Start of day: check smoke CI, browser smoke, worker health, and Stripe webhook health.
- During beta sessions: tail relevant Axiom queries for the active user.
- End of day: summarize blockers, confusing UX, and must-fix bugs before the next invite batch.
