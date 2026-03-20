# Platform Bootstrap and Runtime Secrets Plan

## Goal

Define how Yaffle manages **platform-level** secrets and credentials needed to:

- bootstrap Yaffle infrastructure
- run the control plane safely in ECS
- support shared singleton integrations like DNS, GitHub App auth, and shared Tailscale resources

This document is intentionally **not** about the product-facing `Connections` model. That is tracked separately in:

- `plans/SECRETS_AND_CONNECTIONS_BACKEND_PLAN.md`

## Scope

This document covers two classes of platform concerns:

1. **Bootstrap credentials** — operator-managed credentials used to create foundational infrastructure
2. **Runtime platform secrets** — long-lived secrets/configuration the running control plane service needs continuously

## Problem Statement

We have proven local and ECS runner execution, but moving the control plane itself into ECS requires a cleaner platform secret story.

Today, some platform-level credentials still blur together:

- operator-local secrets
- ECS runtime secrets
- shared singleton provider credentials
- infrastructure provider credentials used by Yaffle's own Terraform

That is acceptable for early development, but not for a production-ready CP-on-ECS story.

## Design Principles

1. **Separate bootstrap from runtime**
2. **Keep platform singleton credentials distinct from user-facing connections**
3. **Use AWS-managed secret/config storage for runtime secrets**
4. **Prefer SSM Parameter Store by default; use Secrets Manager only when justified**
5. **Minimize long-lived credentials in application containers**
6. **Make bootstrap workflows operator-only and explicit**

## Secret Classes

### 1. Bootstrap Credentials

Used to create or modify foundational infrastructure.

Examples:

- AWS bootstrap/admin access
- Cloudflare bootstrap token for shared DNS
- GitHub App bootstrap values
- Tailscale provider credentials for shared tailnet setup

Properties:

- operator-managed
- not part of normal product UX
- may come from 1Password, CI secrets, or operator shell env
- may never be stored by Yaffle itself

### 2. Runtime Platform Secrets

Used continuously by the running control plane.

Examples:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- GitHub App private key / webhook secret
- GitHub OAuth client secret
- telemetry credentials

Properties:

- should be stored in AWS-backed secret/config storage
- injected into ECS task definitions at runtime
- not editable through normal product UX

## Storage Strategy

### Default: SSM Parameter Store SecureString

Use Parameter Store by default for runtime platform secrets because:

- lower cost
- simple secure storage
- ECS consumes it cleanly
- most platform secrets are low-churn and read often

### Use Secrets Manager When Needed

Use Secrets Manager only when we specifically need:

- built-in rotation workflows
- staged versions / richer secret lifecycle semantics
- provider/tooling integrations that fit Secrets Manager better

## What is Platform-Level and Should Stay There

These are platform singleton concerns and should remain outside the user-facing connection system:

- GitHub App credentials for Yaffle itself
- Better Auth platform secrets
- DNS credentials for Yaffle-owned zones
- shared Tailscale tailnet policy/OAuth credentials used by Yaffle infrastructure itself

These belong in places like:

- `infra/shared`
- `apps/control-plane/infra`

not the product-facing `Connections` model.

## Control Plane on ECS Requirements

To move the control plane to ECS safely, the ECS runtime must have all required runtime secrets injected explicitly.

### Required Runtime Inputs

At minimum:

- database connection string
- auth secrets
- GitHub App credentials
- OAuth client secrets
- telemetry credentials (if enabled)
- explicit runtime URLs / public API config

### Required Runtime Configuration

Examples:

- public API URL
- public auth URL
- runner API/TFC-facing config if CP brokers those values
- bucket names
- ECS cluster/network settings

These should be explicit, not hidden behind local-only defaults.

## Bootstrap Workflow

Platform bootstrap should remain a deliberate operator workflow.

Examples:

- applying `infra/shared`
- initial Route53/Cloudflare setup
- initial Tailscale shared tailnet setup
- initial GitHub App secret seeding

This workflow should not be disguised as normal app runtime behavior.

## Implementation Phases

### Phase 1 — Platform Secret Inventory

Inventory every platform-level secret/config input and classify it as:

- bootstrap-only
- runtime-only
- shared singleton provider credential

### Phase 2 — Runtime Secret Store Cleanup

Move control-plane ECS runtime secrets to AWS-backed secret/config storage with explicit task injection.

### Phase 3 — Shared Singleton Review

Review all singleton infra integrations and make sure they are modeled as platform concerns, not user connections.

### Phase 4 — CP-on-ECS Readiness Review

Before moving the control plane fully to ECS, verify:

- no hidden local-only secret dependencies remain
- no platform provider still depends on a developer-local-only assumption
- all required runtime secrets are injectable and documented

## Open Questions

1. Which bootstrap secrets should remain external forever versus being promoted into AWS storage after bootstrap?
2. Which runtime secrets, if any, actually justify Secrets Manager over Parameter Store?
3. Do we want a dedicated internal abstraction for platform singleton credentials distinct from product connections?

## Recommended Immediate Next Step

Produce a platform secret inventory with columns like:

- name
- class (`bootstrap` / `runtime` / `shared-singleton`)
- current source
- target source
- who owns it
- whether CP-on-ECS depends on it
