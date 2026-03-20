# Connections and Credential Providers Plan

## Status

This plan is now partially implemented.

Implemented so far:

- Org Settings inventory for connections
- create flow for env-var and AWS IAM role connections
- edit flow for configured connections
- delete/revoke flow for configured connections
- validation flow for configured connections
- real SSR loading of org connections
- missing-provider detection from cached S3 workspaces
- deduped inferred unconfigured provider rows
- overlap/conflict prevention for ambiguous connection scopes
- execution-time credential resolution for `envvar` and `iam_role`
- scheduler behavior that keeps jobs queued when required connections are missing or conflicting
- org-specific KMS-backed SSM storage for env-var connection secrets

Still remaining:

- make blocked-on-connections state feel first-class in the UI
- improve validation UX and diagnostics
- improve connection usage visibility across overview/env pages
- add route and resolver backend tests
- add profiling/perf regression coverage for org settings + connections flows
- add feature-specific performance telemetry for connection inventory/requirements
- reduce page-load latency caused by requirement discovery on org settings
- remove backend scale cliffs in connection requirement resolution
- decide how mutable a connection is across credential-provider type changes

## Performance Review Notes

The newly added org settings/connections path is functional, but there are several clear performance risks that should be treated as follow-up implementation work.

### Key Findings

- `GET /api/orgs/:slug/connection-requirements` is currently on the critical path for the settings page and can do expensive work inline, including loading latest deployments, reading cached workspace artifacts, and parsing Terraform files.
- `listLatestDeploymentsForOrg` currently loads all deployments for the org and deduplicates in memory, which will degrade as deployment history grows.
- connection requirement inference has an N+1 lookup pattern for run groups and mostly sequential heavy I/O during provider extraction.
- provider discovery uses an unbounded in-process cache for workspace provider lookups, which risks memory growth over time.
- the settings page SSR load currently waits for both connection inventory and missing-requirement inference before rendering, so slow requirement discovery directly hurts perceived UX.
- baseline HTTP and DB telemetry exists, but this feature does not yet have feature-specific spans/metrics for requirement discovery, cache behavior, or end-user route latency budgets.

### Recommended Performance Plan

1. Define explicit budgets for:
   - `GET /api/orgs/:slug/connections`
   - `GET /api/orgs/:slug/connection-requirements`
   - settings page data-ready and key interactions (especially opening/editing connections)
2. Add profiling/regression coverage:
   - endpoint-level perf harnesses for small/medium/large org datasets
   - a focused benchmark/profile for `findMissingConnectionRequirements`
   - a lightweight browser timing check for settings page load and modal interaction
3. Add feature-specific observability:
   - requirement-resolution duration histogram
   - deployments/providers scanned histograms
   - provider cache hit/miss counters
   - route phase spans and `Server-Timing` for the settings/connections endpoints
4. Remove obvious backend scale cliffs:
   - move latest-deployment dedupe into SQL instead of in-memory post-processing
   - batch run-group lookups instead of per-deployment lookup
   - dedupe provider extraction work by workspace artifact + path
   - process provider extraction with bounded concurrency
   - replace the unbounded provider cache with a bounded TTL/LRU strategy
5. Improve perceived UI speed:
   - render connection inventory immediately
   - load inferred missing requirements progressively or via stale-while-revalidate instead of blocking first paint

## Goal

Design the **product/backend model** for how Yaffle manages user-facing credentials and external system access.

This document is specifically about the product notion of:

- connections
- credential providers
- credential storage references
- execution-time credential resolution
- user experience for creating and using credentials

This document is **not** the place to design platform bootstrap/runtime secrets for Yaffle itself. That is tracked separately in:

- `plans/PLATFORM_BOOTSTRAP_AND_RUNTIME_SECRETS_PLAN.md`

## Problem Statement

We do not want Yaffle to accumulate provider-specific credential handling for every Terraform provider.

Most Terraform providers ultimately consume credentials through one of a few patterns:

- environment variables
- short-lived cloud credentials (for example AWS STS)
- occasional provider-specific auth flows that justify specialized support

So the product should not primarily model "Cloudflare connection", "Grafana connection", "Tailscale connection" as bespoke backend types.

Instead, Yaffle should model a small number of **credential delivery strategies** and let users attach them to workspaces/environments.

## Design Principles

1. **Prefer generic credential delivery over provider-specific logic**
2. **Store secret material outside Postgres**
3. **Store connection metadata and policy in Postgres**
4. **Resolve credentials just-in-time for execution**
5. **Prefer short-lived execution credentials where possible**
6. **Make credential scope visible to users**
7. **Give AWS a polished first-class path because it will be common**

## Core Abstraction: CredentialProvider

The primary backend abstraction should be a `CredentialProvider`.

```ts
interface CredentialProvider {
  type: string

  validate(config: unknown): Promise<ValidationResult>

  resolveExecutionCredentials(input: {
    orgId: string
    environmentName: string
    workspacePath: string
  }): Promise<ResolvedCredentials>
}
```

Where `ResolvedCredentials` looks roughly like:

```ts
type ResolvedCredentials = {
  env: Record<string, string>
  expiresAt?: Date
  auditMetadata?: Record<string, string>
}
```

## Initial CredentialProvider Types

### 1. EnvironmentVariableCredentialProvider

This should be the default and most important provider type.

It models the common Terraform pattern:

- user configures one or more env var names
- user provides values (or secure references)
- Yaffle injects those env vars into execution

This should cover most providers without Yaffle needing provider-specific backend behavior.

Examples it can support:

- `CLOUDFLARE_API_TOKEN`
- `GRAFANA_AUTH`
- `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET`
- arbitrary `TF_VAR_*`-style or provider env patterns when needed

### 2. IAMRoleCredentialProvider

AWS deserves a smoother path.

Instead of making users paste static env vars when they really want role assumption, we should support a dedicated AWS IAM role provider.

Behavior:

- user configures a role ARN
- Yaffle validates assume-role access
- Yaffle assumes the role just-in-time
- runner gets short-lived STS env vars

This is the main specialized provider worth supporting early.

### 3. Future Specialized Providers Only When Justified

Add specialized credential providers only if they unlock a real UX or security improvement.

Examples that may justify specialization later:

- OIDC cloud providers
- provider-specific refresh flows
- providers where Yaffle can discover/test resources in a uniquely valuable way

## Connection Object Model

The product-facing object is still a `Connection`, but internally it should point to a `CredentialProvider` implementation.

In other words:

- `Connection` = user/org-facing resource
- `CredentialProvider` = backend strategy for validation and execution delivery

### Suggested Connection Metadata

- `id`
- `org_id`
- `provider_type` — user-facing category like `aws`, `cloudflare`, `tailscale`, `generic`
- `credential_provider_type` — backend strategy like `envvar`, `iam_role`
- `display_name`
- `secret_ref_store`
- `secret_ref_path`
- `status`
- `allowed_environments`
- `allowed_workspaces`
- `owner_user_id`
- `last_validated_at`
- `last_validation_error`
- `created_at`
- `updated_at`

### Current Implemented Metadata

The current implementation now stores:

- `provider_type`
- `credential_provider_type`
- `secret_store`
- `secret_path`
- `secret_arn`
- `last_validated_at`
- `last_validation_error`
- `updated_at`

The older `type` and `config` fields still exist and are still in use, but the implementation is actively moving toward the normalized metadata above.

## Secret Material Storage

This document assumes secret material is stored outside Postgres in an AWS-backed secret/config store.

We should prefer:

- **SSM Parameter Store SecureString** by default
- **Secrets Manager** when rotation/versioning features are specifically needed

The backend should hide which backing store is used.

Suggested secret reference model:

```ts
type SecretRef = {
  store: "ssm" | "secrets_manager"
  pathOrArn: string
  version?: string
}
```

Suggested naming:

```text
/yaffle/org/<org_slug>/connections/<connection_id>/<name>
```

## Resolution Flow

Before a run starts, the control plane should answer:

1. Which credential providers are required for this workspace?
2. Which connections satisfy those requirements?
3. Are those connections allowed in this environment/workspace?
4. What execution env vars or short-lived creds should the runner receive?

Suggested resolution API:

```ts
resolveCredentials({
  orgId,
  environmentName,
  workspacePath,
  requirements,
})
```

This should return resolved execution credentials or a clear error.

### Current Implemented Resolution Flow

Implemented:

- scheduler checks connection readiness before spawning work
- runner context resolves execution credentials before execution starts
- when connections are missing/conflicting:
  - jobs remain queued
  - a blocked reason is persisted on the job
  - workers are not spawned

Currently supported credential resolution:

- `envvar` → inject env vars from org-scoped SSM secure values
- `iam_role` → assume role and inject short-lived STS credentials

## Onboarding and Missing-Connection Behavior

There is an important bootstrap/product race to handle:

- a user may connect a repo before `yaffle.toml` exists
- or `yaffle.toml` may exist before the required connections are configured
- env/workspace-aware scoping means we cannot fully bind credentials until the config exists

### Proposed Rule

`yaffle.toml` is the source of truth for workspace/environment structure.

That means:

- users may create connections ahead of time at the org level
- but precise env/workspace binding happens only once `yaffle.toml` exists and is parsed

### Run Behavior When Connections Are Missing

If a run is triggered and required connections are missing for that workspace/environment:

- do **not** fail the run immediately
- keep the job queued / blocked
- surface a clear notice in the UI that execution is waiting for required connections
- resume execution automatically once the required connections are configured

### Current Implemented Behavior

Implemented:

- missing/conflicting connections prevent execution
- scheduler leaves jobs queued rather than failing them immediately
- inferred missing connections are surfaced in Org Settings as unconfigured rows

Partially implemented:

- blocked state is visible in some UI contexts, but should become more explicit and first-class

This keeps the onboarding path smooth:

- connect repo
- push `yaffle.toml`
- Yaffle discovers provider requirements
- Yaffle tells you what connections are missing
- runs wait safely until those connections exist

### Provider Discovery

We should parse provider requirements from the workspace code and use that to assist setup.

Examples:

- detect Terraform providers used in a workspace
- infer likely required env vars or suggested credential provider types
- pre-fill the connection setup flow with the providers/env vars the workspace likely needs

This should make setup feel guided rather than manual.

### Current Implemented Discovery

Implemented:

- provider requirements are scanned from the cached S3 workspace snapshot
- the scanner does **not** go back to GitHub
- utility providers like `null`, `random`, `local`, etc. are filtered out
- missing providers are grouped into deduped unconfigured inventory rows

Still to improve:

- broader Terraform parsing coverage
- clearer explanation of why a provider is required

### UX Implication

The product should clearly distinguish between:

- `connection exists`
- `connection is scoped to this env/workspace`
- `workspace is blocked waiting for required connections`

This means a repo can be onboarded before all credentials are configured, while still preserving safe execution behavior.

## Execution Credential Broker

The control plane should have a single broker that:

- resolves connections
- loads underlying secret material
- mints short-lived credentials where applicable
- produces the final env vars passed to execution

Examples:

### EnvironmentVariableCredentialProvider

- fetch secure values
- map values into env vars
- inject only the requested env vars

### Current Implemented Behavior

Implemented:

- secret values stored in SSM Parameter Store SecureString
- encrypted with org-specific KMS key
- loaded at execution time
- injected into runner env

### IAMRoleCredentialProvider

- assume role
- return short-lived `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`

### Current Implemented Behavior

Implemented:

- validation via real `AssumeRole`
- execution-time short-lived STS credentials injected into runner env

## Product UX

Users should think in terms of **Connections**, not raw env vars hidden in infra.

### Core User Flow

User goes to `Connections` and chooses:

- connection name
- connection type / provider category
- credential provider type
- credential details
- scope (org / environment / workspace)

### Example: Generic Env-Var Credential Provider

1. Create connection
2. Choose provider category (for display/filtering), for example `Cloudflare` or `Generic`
3. Choose credential provider type: `Environment Variable`
4. Enter env var names and secure values
5. Yaffle validates the shape and optionally tests connectivity
6. User scopes it to environments/workspaces

### Current Implemented UX

Implemented:

- create drawer in Org Settings
- structured key/value editor (no longer raw textarea)
- provider selector for env-var connections
- env/workspace scope chips and custom patterns
- edit and delete actions for configured connections

### Example: AWS IAM Role Credential Provider

1. Create connection
2. Choose provider category: `AWS`
3. Choose credential provider type: `IAM Role`
4. Enter role ARN and optional external ID/session options
5. Yaffle validates assume-role access
6. User scopes it to environments/workspaces

### Current Implemented UX

Implemented:

- dedicated AWS IAM role create/edit path
- role ARN + external ID support
- validation via real `AssumeRole`

Still to improve:

- stronger AWS-specific copy and diagnostics
- clearer trust-policy guidance

## AWS UX Goals

AWS should be smoother than generic env-var credentials.

Potential UX:

- guided trust policy snippet
- account ID / caller identity shown after validation
- clear errors for trust-policy vs permission failures
- recommended defaults for session duration
- environment/workspace scoping helper

## During Runs

Yaffle should surface:

- which connection(s) were used
- which credential provider strategy was used
- whether credentials were ephemeral
- why a connection failed if it failed

Possible failure categories:

- auth failure
- missing connection
- scope/policy denial
- network failure
- provider-side failure

### Current Implemented Surfacing

Implemented:

- overview page can show blocked-by-connection counts
- env detail page can show missing/conflicting connection badges linking to Settings
- env detail page can show which configured connections are in use for the selected workspace

Still to improve:

- clearer first-class blocked state treatment
- better connected/missing connection visibility across all major run views

## Security and Audit

We should add or standardize:

- audit events when connections are created, validated, updated, or deleted
- audit events when secret references change
- audit events when connections are used for a run
- least-privilege reads from the underlying secret store

### Current Implemented Security Properties

Implemented:

- env-var secret values are not stored in Postgres
- env-var secret values are stored in SSM SecureString
- SSM writes use the org-specific KMS key
- connection overlap/conflict is rejected to avoid ambiguous execution behavior

## Implementation Phases

### Phase 1 — Connection Inventory and Requirements

Identify current and expected credential use cases, grouped by delivery strategy instead of provider brand.

Deliverable:

- list of required credential provider types
- list of likely user-facing provider categories

### Phase 2 — Secret Store Abstraction

Build a backend abstraction over SSM Parameter Store / Secrets Manager references.

Deliverable:

- uniform `SecretRef` handling

### Phase 3 — CredentialProvider Backend

Implement the first `CredentialProvider` strategies:

- `EnvironmentVariableCredentialProvider`
- `IAMRoleCredentialProvider`

Deliverable:

- validation + execution resolution for both types

Status: **partially implemented**

### Phase 4 — Connection Metadata and Policy

Evolve `connections` into the canonical metadata layer.

Deliverable:

- connection schema
- environment/workspace scoping
- validation status tracking
- connection requirement resolution that scales with org history size
- bounded caching / no obvious in-memory scale cliffs in requirement inference

Status: **partially implemented**

### Phase 5 — Product UX

Add a `Connections` UI for org admins/users.

Deliverable:

- create/test/update/remove connections
- workspace/environment scoping
- health/validation feedback
- connection inventory that renders quickly even when requirement inference is cold
- settings page behavior that does not block first paint on expensive requirement discovery

Status: **partially implemented**

Implemented:

- inventory
- create
- edit
- delete
- validate
- inferred unconfigured rows

Still remaining:

- stronger blocked-state UX
- stronger validation messaging
- more polished create/edit ergonomics
- progressive loading or stale-while-revalidate behavior for inferred missing requirements

### Phase 6 — Performance and Observability

Make the org settings/connections feature feel sharp under realistic org size and deployment history.

Deliverable:

- route-level latency budgets for connection inventory and requirement inference
- perf regression coverage for small/medium/large seeded org datasets
- feature-specific spans/metrics for requirement inference, cache behavior, and settings route latency
- removal of obvious scale cliffs in deployment dedupe, run-group lookup, and provider extraction

Status: **not yet implemented**

## Remaining Implementation Work

### 1. Blocked-on-Connections UX

- make blocked state feel first-class, not secondary text
- clarify whether workspace is blocked by:
  - missing connections
  - conflicting connections

### 2. Validation UX

- richer validation callouts
- better timestamps / relative times
- stronger AWS-specific diagnostics

### 3. Execution Visibility

- show which connection is actively being used in more places
- improve overview/env detail visibility

### 4. Backend Tests

- route tests for create/update/delete/validate
- resolver tests for envvar and iam_role
- scheduler blocking tests for missing/conflicting connections

### 5. Performance and Observability

- define p75/p95 latency budgets for:
  - `GET /api/orgs/:slug/connections`
  - `GET /api/orgs/:slug/connection-requirements`
  - settings page data-ready and edit-modal interaction
- add endpoint perf/profiling tests with seeded small/medium/large org datasets
- add focused profiling coverage for `findMissingConnectionRequirements`
- add feature-specific telemetry:
  - requirement-resolution duration histogram
  - deployments/providers scanned histograms
  - provider cache hit/miss counters
  - route phase spans and `Server-Timing`
- move latest-deployment dedupe into SQL rather than loading all deployments and deduping in memory
- batch run-group lookups instead of per-deployment N+1 fetches
- dedupe provider extraction work by workspace artifact + workspace path
- add bounded concurrency for provider extraction/parsing work
- replace unbounded in-process provider cache with bounded TTL/LRU behavior
- make settings UX load connection inventory immediately rather than blocking on expensive inferred requirement discovery

### 6. Mutability Decision

- decide whether changing a connection from one credential-provider type to another is allowed in place or should require creating a new connection

## Open Questions

1. Connection scoping should be env/workspace-aware from day one. Separate AWS accounts for prod/nonprod is a common pattern we must support immediately.
2. Clarify whether generic env-var providers should accept only literal secure values or also support references/mapping to customer-managed stores (for example customer SSM paths) without Yaffle storing the raw value.
3. Clarify whether a `Connection` is immutable in provider strategy once created. Example: a user first creates an AWS connection backed by static env vars, then later wants to migrate that same logical connection to IAM role assumption. Is that an in-place edit or a new connection?
4. AWS-specific polish should be very high in v1. The AWS path should feel close to first-class and production-ready, not like a generic fallback.

## Recommended Immediate Next Step

Continue implementation with:

1. blocked-on-connections UX tightening
2. validation UX tightening
3. route/resolver/scheduler backend correctness tests
4. profiling/perf regression tests for org settings connections flows
5. feature-specific telemetry for connection requirement discovery
