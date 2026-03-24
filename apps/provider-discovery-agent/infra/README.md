# Provider Discovery Agent Infrastructure

This workspace manages the Cloudflare-side hostname for the provider discovery worker.

## What it owns

- Preview and production worker hostnames
- Proxied Cloudflare DNS records for those hostnames
- Secrets Manager secret containers for environment-specific worker runtime secrets
- Deploy metadata surfaced as Terraform outputs for GitHub Actions

## What it does not own

- Worker code deployment (`wrangler deploy` handles that)
- Secret values (populate the created Secrets Manager secrets out of band)

## Outputs consumed by CI

- `worker_name`
- `worker_host`
- `worker_route_pattern`
- `worker_url`
- `ai_gateway_id`
- `*_secret_id` outputs for Secrets Manager-backed deploy/runtime secrets

PR previews should deploy to the preview hostname from this workspace before merge.

## Runtime secret IDs

The deploy workflow expects these Secrets Manager secrets to exist:

- `/yaffle/shared/cloudflare/account-id`
- `/yaffle/shared/cloudflare/api-token`
- `/yaffle/<environment>/provider-discovery-agent/agent-token`
- `/yaffle/<environment>/provider-discovery-agent/callback-secret`
- optional `/yaffle/<environment>/provider-discovery-agent/github-token`
