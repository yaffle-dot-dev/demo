# Provider Discovery Agent (Cloudflare)

This worker runs a Cloudflare `Agent` (`ProviderDiscoveryAgent`) that researches unknown Terraform
providers and posts signed results back to the control plane callback endpoint.

Signed callbacks include `x-yaffle-timestamp`, `x-yaffle-nonce`, and `x-yaffle-signature`.

## Why this exists

- Keep control-plane parse and readiness checks fast
- Discover likely credential environment variables for unknown providers asynchronously
- Auto-promote high-confidence signatures in the control plane

## Endpoints

- `POST /discover`
  - Auth: `Authorization: Bearer <YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN>`
  - Body shape matches the control-plane dispatch payload
- `GET /health`

## Required secrets / vars

- `YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN` (secret)
- `YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET` (secret, shared with control plane)

Optional:

- `GITHUB_TOKEN` (secret, improves GitHub API rate limits)
- `YAFFLE_PROVIDER_DISCOVERY_AI_MODEL` (var, default `@cf/zai-org/glm-4.7-flash`)
- `YAFFLE_PROVIDER_DISCOVERY_CALLBACK_TIMEOUT_MS` (var, default `8000`)
- `YAFFLE_PROVIDER_DISCOVERY_MAX_DOCS` (var, default `24`)

## Local dev

```bash
bun install
bun run --filter=@yaffle/provider-discovery-agent dev
```

## Deploy

```bash
bun run --filter=@yaffle/provider-discovery-agent deploy
nix run .#build-provider-discovery-agent
nix run .#deploy-provider-discovery-agent -- --env main
```

For preview deploys:

```bash
nix run .#deploy-provider-discovery-agent -- --pr 123
```

The Nix deploy script resolves `apps/provider-discovery-agent/infra` outputs via Yaffle,
uses env vars when present, and otherwise falls back to the Secrets Manager secret IDs
exported by that workspace. Set `YAFFLE_API_URL` and `YAFFLE_API_TOKEN` so it can read
workspace outputs.

## CI/CD

- Terraform workspace: `apps/provider-discovery-agent/infra`
- Workflow: `.github/workflows/deploy-provider-discovery-agent.yml`
- Preview and production deploys fetch infra outputs from Yaffle before running `wrangler deploy`
- GitHub Actions connects to the tailnet first when `vars.YAFFLE_API_URL` points at a tailnet control plane
- Worker deploy secrets are loaded from AWS Secrets Manager via the GitHub Actions CI role
- If those repo variables are unset, workflows fall back to `http://yaffle.tail66f312.ts.net:3000`
- Worker observability logs are enabled in Wrangler for deploy-time diagnostics
- Workers AI extraction routes through the AI Gateway ID surfaced by `apps/provider-discovery-agent/infra`
- Discovery uses deterministic official-source fetching plus Workers AI extraction; `/discover/direct` is the recommended smoke-test route

Expected GitHub repository configuration:

- Variables
  - `YAFFLE_API_URL`
  - `YAFFLE_TAILSCALE_PING_TARGET`

Expected Secrets Manager secret IDs:

- `/yaffle/shared/cloudflare/account-id`
- `/yaffle/shared/cloudflare/api-token`
- `/yaffle/<environment>/provider-discovery-agent/agent-token`
- `/yaffle/<environment>/provider-discovery-agent/callback-secret`
- optional `/yaffle/<environment>/provider-discovery-agent/github-token`

## Control-plane integration

Point control plane to this worker URL:

- `YAFFLE_PROVIDER_DISCOVERY_AGENT_ENDPOINT=https://<worker-domain>/discover`

And keep the shared callback secret/token values aligned between both services.
