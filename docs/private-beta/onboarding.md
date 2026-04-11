# Private Beta Onboarding

Use this for the first external users. Keep it short and hands-on.

## What To Send Each Beta User

```
Hey! I’m opening a tiny private beta for Yaffle.

Yaffle creates preview Terraform environments for pull requests so you can see infra changes before merge.

To get started:
1. Sign in with GitHub
2. Create your Yaffle org
3. Install the Yaffle GitHub App on the repo/org you want to test
4. Link one repo in Yaffle settings
5. Open a PR and watch the preview show up

If anything feels weird, send me:
- your org slug
- repo name
- PR number if you have one
- a screenshot of the page you’re on
```

## Beta User Prerequisites

- GitHub account with access to the target repository
- A repo that Yaffle can install its GitHub App into
- One safe Terraform/OpenTofu repo to use as the first test case
- Willingness to share screenshots / feedback quickly

## Recommended First Session

1. Sign in with GitHub.
2. Create a new org.
3. Install the GitHub App.
4. Link exactly one repo.
5. Open one PR with a small, reversible infrastructure change.
6. Confirm the preview appears and the plan looks sane.
7. Close or merge the PR and confirm cleanup.

## What We Want The User To Report

- Anything confusing in org creation or GitHub App install
- Missing or unclear billing messaging
- Missing-provider / connection setup confusion
- Latency: where they felt the product was waiting too long
- Trust: whether the preview output felt safe enough to merge

## Known Beta Constraints To State Up Front

- Beta onboarding is currently concierge-supported.
- Shared org member management is not the day-one path.
- If billing or provider discovery misbehaves, we may switch the user to a manual fallback while we fix it.
