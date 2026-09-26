# Yaffle Multi-Cloud IaC Orchestration Demo

This repository demonstrates one Yaffle environment graph orchestrating two
infrastructure engines and two provider boundaries:

- OpenTofu manages the existing local, application, database, and feature-flag
  workspaces.
- Alchemy manages a public Cloudflare Worker and its Workers KV namespace.

A pull request produces one `pr-{number}` environment across both engines.
Yaffle keeps each engine's state native while applying the same environment
identity, approval, output, and teardown lifecycle to the complete graph.

## Automatic OpenTofu preview isolation

The `infra/preview-isolation` workspace configures one stable filename:

```toml
variables.resource_name = "yaffle-product-demo"
```

Yaffle materializes an isolated name for a pull request without rewriting the
repository source.

| Event                          | Environment   | Materialized filename                 |
| ------------------------------ | ------------- | ------------------------------------- |
| Pull request opened or updated | `pr-{number}` | `yaffle-product-demo-{stable-suffix}` |
| Pull request closed            | `pr-{number}` | Preview resource destroyed            |
| Push to `main`                 | `production`  | `yaffle-product-demo`                 |

The exact `hashicorp/local` `2.5.3` strategy keeps this part of the demo free
while exercising provider resolution, immutable source transformation, plan,
apply, outputs, and destroy.

## Cloudflare preview

The `infra/cloudflare` workspace is authored with Alchemy. Every selected
environment receives:

- one public Cloudflare Worker exposing `/` and `/health`;
- one Workers KV namespace bound to that Worker; and
- durable Cloudflare-hosted Alchemy state.

The Worker reads an optional `message` value from KV but performs no
request-driven writes. Observability is disabled for this low-volume harness.
Its URL and resource identifiers use Yaffle's Terraform-compatible output
envelope so the control plane can apply the same sensitivity and sharing rules
regardless of engine.

The URL is currently an internal Yaffle output. It is visible to this
repository's environment graph but is not exported to another repository.

## Run the demo

Prerequisites:

1. Install the Yaffle GitHub App for this repository and connect it to your
   Yaffle organization.
2. Configure the existing OpenTofu provider connections required by the
   selected workspaces.
3. Add a Cloudflare connection scoped to `infra/cloudflare`. It must provide
   `CLOUDFLARE_ACCOUNT_ID` plus either `CLOUDFLARE_API_TOKEN` or Alchemy's
   API-key/email credential pair.
4. Allow the first hosted plan to bootstrap or upgrade Alchemy's shared
   Cloudflare state-store Worker. The plan remains a dry run for repository
   resources; only this provider prerequisite may be created during planning.

Then:

1. Create a branch and change either demo message in `yaffle.toml`.
2. Open a pull request.
3. Watch Yaffle plan the OpenTofu and Alchemy workspaces under one transient
   environment.
4. Approve and deploy the preview.
5. Inspect the OpenTofu outputs and request the Cloudflare Worker's `/health`
   endpoint.
6. Close the pull request and watch Yaffle destroy the preview in reverse
   dependency order.

## Cross-engine outputs

Both engines already report outputs through the same immutable Yaffle output
contract. The next adapter boundary is consumption: an engine-neutral workspace
dependency declaration can inject an authorized output snapshot into Alchemy,
OpenTofu, Pulumi, or a future engine without granting access to the producer's
native state backend.

That keeps the product abstraction at `workspace -> outputs`, rather than
coupling orchestration to Terraform modules or Alchemy state internals.

## Validate locally

```bash
tofu -chdir=infra/preview-isolation fmt -check
tofu -chdir=infra/preview-isolation init -backend=false -lockfile=readonly
tofu -chdir=infra/preview-isolation validate
pnpm typecheck
```
