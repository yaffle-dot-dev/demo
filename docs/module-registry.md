# Yaffle Module Registry

Infrastructure as a Product - A TFC-compatible module registry that auto-generates
typed modules from workspace outputs.

## Overview

Platform teams publish infrastructure, app teams consume it like any Terraform module:

```hcl
module "vpc" {
  source = "yaffle.dev/acme--platform/core-infrastructure--vpc/yaffle"
}

resource "aws_security_group" "api" {
  vpc_id = module.vpc.vpc_id  # Typed! Autocomplete works!
}
```

### Key Benefits

- **Type safety**: Generated modules have typed outputs, IDE autocomplete works
- **No magic strings**: Reference infrastructure by module, not hardcoded IDs
- **Preview-aware**: Modules resolve to production or preview state as appropriate
- **Explicit platform API surface**: Producers choose which outputs are same-repo only vs cross-repo shareable
- **Standard Terraform**: Uses native module syntax, no custom providers

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Terraform CLI                                   │
│    module "vpc" { source = "yaffle.dev/acme--platform/core-infrastructure--vpc/yaffle" } │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         yaffle.dev (Control Plane)                           │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Module Registry Protocol                            │  │
│  │  GET /tfc/registry/v1/modules/:ns/:name/:provider/versions            │  │
│  │  GET /tfc/registry/v1/modules/:ns/:name/:provider/:ver/download       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                      │                                       │
│                                      ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                       Shim Module Generator                            │  │
│  │  1. Lookup workspace by module path                                   │  │
│  │  2. Get current state version                                         │  │
│  │  3. Extract outputs with types                                        │  │
│  │  4. Generate HCL module with typed outputs                            │  │
│  │  5. Bake in current output values                                     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                      │                                       │
│                                      ▼                                       │
│  ┌─────────────────────┐    ┌────────────────────────────────────────────┐  │
│  │      Postgres       │    │                    S3                       │  │
│  │  ────────────────   │    │  ──────────────────────────────────────    │  │
│  │  workspaces         │    │  {workspace_id}/v{serial}.tfstate          │  │
│  │  state_versions     │◄───│  {workspace_id}/modules/v{serial}.tar.gz   │  │
│  │  (outputs jsonb)    │    │                                            │  │
│  └─────────────────────┘    └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## User Experience

### For Platform Teams (Publishers)

Same-repo modules work automatically from normal Terraform outputs. To share a
workspace across repos, the producer explicitly exports a curated output surface
in `yaffle.toml`.

Terraform stays normal:

```hcl
# core-infrastructure/vpc/main.tf
resource "aws_vpc" "main" {
  cidr_block = var.cidr_block
  # ...
}

resource "aws_subnet" "private" {
  count  = length(var.availability_zones)
  vpc_id = aws_vpc.main.id
  # ...
}

# core-infrastructure/vpc/outputs.tf
output "vpc_id" {
  description = "The VPC ID"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = aws_subnet.private[*].id
}

output "cidr_block" {
  description = "VPC CIDR block"
  value       = aws_vpc.main.cidr_block
}
```

When this workspace's state is uploaded, Yaffle automatically makes it available
as a module at `yaffle.dev/<org>--<repo>/core-infrastructure--vpc/yaffle`.

To expose outputs across repos in the same Yaffle org, add export rules:

```toml
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/eks"
environments = ["main"]

[[workspaces.exports]]
outputs = ["cluster_endpoint", "cluster_ca"]
visibility = "public"
consumers = ["acme/applications/apps/*"]

[[workspaces.exports]]
outputs = ["cluster_security_group_id", "oidc_provider_arn"]
visibility = "internal"
```

Interpretation:

- `internal` outputs are available only to downstream workspaces in the same repo
- `public` outputs are available only to explicitly allowlisted workspaces in the same Yaffle org
- cross-org module sharing is not supported

### For App Teams (Consumers)

Reference infrastructure as modules:

```hcl
# apps/api/infra/main.tf
module "vpc" {
  source = "yaffle.dev/acme--platform/core-infrastructure--vpc/yaffle"
}

module "eks" {
  source = "yaffle.dev/acme--platform/core-infrastructure--eks/yaffle"
}

resource "aws_security_group" "api" {
  name   = "api-sg"
  vpc_id = module.vpc.vpc_id  # Typed! IDE autocomplete works!

  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

resource "kubernetes_deployment" "api" {
  # ...
  spec {
    template {
      spec {
        container {
          env {
            name  = "VPC_CIDR"
            value = module.vpc.cidr_block
          }
        }
      }
    }
  }
}
```

Benefits:
- `module.vpc.` triggers autocomplete in IDE
- Invalid output references caught by `terraform validate`
- No hardcoded VPC IDs, subnet IDs, etc.

If the producer uses export rules:

- same-repo consumers still see all outputs
- cross-repo consumers only see the producer's `public` outputs
- local/user-token access to export-controlled modules is not yet the polished path; the supported launch flow is Yaffle-managed runs using workspace-scoped run tokens

---

## Service Discovery

Add `modules.v1` to `/.well-known/terraform.json`:

```json
{
  "tfe.v2": "/tfc/api/v2/",
  "modules.v1": "/tfc/registry/v1/modules/"
}
```

---

## Module Registry Protocol

Implements the [Terraform Module Registry Protocol](https://developer.hashicorp.com/terraform/internals/module-registry-protocol).

### URL Structure

Module source `yaffle.dev/acme--platform/core-infrastructure--vpc/yaffle` maps to:

| Component | Value | Source |
|-----------|-------|--------|
| hostname | `yaffle.dev` | From module source |
| namespace | `acme--platform` | `{org_slug}--{repo}` |
| name | `core-infrastructure--vpc` | Workspace path (slashes → `--`) |
| provider | `yaffle` | Constant (not provider-specific) |

### Intra-Repo vs Inter-Repo Sources

Yaffle uses the module namespace to decide whether a module reference is part of
the current repo's orchestration graph or just a normal external module.

| Reference type | Namespace compared to current repo | Registry resolution | Included in DAG |
|----------------|------------------------------------|---------------------|-----------------|
| Intra-repo | Same namespace | Preview-aware, last-known-good state | Yes |
| Cross-repo (same org) | Different repo in same org | Normal registry dependency | No |
| Cross-org | Different Yaffle org | Not supported | No |

Examples:

```hcl
# Same repo: candidate DAG edge
module "shared" {
  source = "yaffle.dev/acme--app/infra--shared/yaffle"
}

# Cross repo: registry dependency, never a DAG edge in this repo
module "cluster" {
  source = "yaffle.dev/acme--platform/platform--eks/yaffle"
}
```

### List Versions

```http
GET /tfc/registry/v1/modules/acme--platform/core-infrastructure--vpc/yaffle/versions
Authorization: Bearer <token>
```

Response:
```json
{
  "modules": [
    {
      "versions": [
        { "version": "1.0.42" },
        { "version": "1.0.41" },
        { "version": "1.0.40" }
      ]
    }
  ]
}
```

Versions correspond to state version serials: `1.0.{serial}`.

### Download Module

```http
GET /tfc/registry/v1/modules/acme--platform/core-infrastructure--vpc/yaffle/1.0.42/download
Authorization: Bearer <token>
```

Response:
```http
HTTP/1.1 204 No Content
X-Terraform-Get: /tfc/registry/v1/modules/acme--platform/core-infrastructure--vpc/yaffle/1.0.42/archive.tar.gz
```

The archive contains the generated shim module.

## Export Visibility and Authz

Cross-repo sharing is controlled by the producer workspace.

### Visibility Classes

| Visibility | Who can read it | Included in same-repo module | Included in cross-repo module |
|------------|-----------------|------------------------------|-------------------------------|
| `internal` | Same-repo downstream workspaces | Yes | No |
| `public` | Allowlisted workspaces in the same Yaffle org | Yes | Yes, if allowlisted |

### Authorization Rules

- same-repo consumers are treated as internal platform composition and can read the full module surface
- cross-repo consumers must be explicitly allowlisted by the producer in `yaffle.toml`
- consumer identity comes from the Yaffle run token's workspace context
- if the consumer workspace cannot be resolved, access is denied by default
- if the producer config cannot be loaded, access is denied by default
- cross-org module sharing is explicitly denied

### Sensitive Outputs

Terraform outputs marked `sensitive = true` cannot be exported as `public`.

Instead:

1. store the secret value in AWS Secrets Manager or SSM Parameter Store
2. output the ARN, name, or other stable reference
3. grant the consuming workload IAM permission to read the secret directly

This keeps the module registry focused on platform API surfaces, not secret distribution.

---

## Shim Module Generation

When a module is requested, Yaffle generates a shim module on-the-fly.

### Input: State Outputs

From the workspace's current state:

```json
{
  "outputs": {
    "vpc_id": {
      "value": "vpc-0123456789abcdef0",
      "type": "string"
    },
    "private_subnet_ids": {
      "value": ["subnet-aaa", "subnet-bbb"],
      "type": ["list", "string"]
    },
    "cidr_block": {
      "value": "10.0.0.0/16",
      "type": "string"
    }
  }
}
```

### Output: Shim Module

```hcl
# main.tf
# Generated by Yaffle
# Workspace: core-infrastructure/vpc
# State serial: 42
# Generated at: 2024-03-06T12:00:00Z

locals {
  # Output values baked in from state
  _outputs = {
    vpc_id             = "vpc-0123456789abcdef0"
    private_subnet_ids = ["subnet-aaa", "subnet-bbb"]
    cidr_block         = "10.0.0.0/16"
  }
}

output "vpc_id" {
  description = "The VPC ID"
  value       = local._outputs.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = local._outputs.private_subnet_ids
}

output "cidr_block" {
  description = "VPC CIDR block"
  value       = local._outputs.cidr_block
}
```

### Type Inference

Terraform state includes output values and types. Map to HCL types:

| State Type | HCL Type |
|------------|----------|
| `"string"` | `string` |
| `"number"` | `number` |
| `"bool"` | `bool` |
| `["list", "string"]` | `list(string)` |
| `["map", "number"]` | `map(number)` |
| `["set", "string"]` | `set(string)` |
| `["object", {...}]` | `object({...})` |
| `["tuple", [...]]` | `tuple([...])` |

For complex nested types, fall back to `any` if needed.

### Caching

Generated modules are cached:

```
S3: {workspace_id}/modules/v{serial}.tar.gz
```

Cache key: `(workspace_id, serial)`

Invalidation: Automatic when new state version uploaded.

---

## Preview-Aware Resolution

When a caller provides preview context, Yaffle resolves the requested module to
the best available finalized state.

### The Problem

- A preview workspace may exist before it has uploaded any finalized state
- The latest attempt may have failed, leaving the last good state unchanged
- Callers still need a stable module surface while preview runs are in flight

### Resolution Algorithm

```
resolveModule(moduleSource, previewContext, requestedVersion):
  workspacePath = parseWorkspacePath(moduleSource)

  if previewContext is null:
    return nonPreviewFinalizedState(workspacePath, requestedVersion)

  previewWorkspace = findPreviewWorkspace(workspacePath, previewContext.prNumber)
  if previewWorkspace has a finalized state for requestedVersion:
    return previewWorkspace.finalizedState

  return nonPreviewFinalizedState(workspacePath, requestedVersion)
```

In practice this means:

- preview state wins only when it is finalized and readable
- if a preview workspace exists but has no finalized state yet, Yaffle falls
  back to the repo's non-preview workspace
- module downloads continue to work from the last known good state after a
  failed preview upload or discarded pending state

### Preview Context

Pass preview context via query parameter:

```hcl
module "vpc" {
  source = "yaffle.dev/acme--platform/core-infrastructure--vpc/yaffle?preview=pr-42"
}
```

Or Yaffle injects this when generating the runner's Terraform config.

---

## Dependency Inference and DAG Construction

`yaffle.toml` declares which workspaces exist in a repo. Yaffle does **not**
currently store explicit dependency edges there. Instead, it infers edges by
scanning Terraform files for Yaffle module sources.

### How Yaffle Builds the DAG

For each workspace in the current repo:

1. Read `.tf` files under the workspace path
2. Parse `module` blocks and extract `source`
3. Keep only Yaffle module sources on allowlisted hosts
4. Keep only sources whose namespace matches the current repo's
   `{org_slug}--{repo}` namespace
5. Convert the module name back into a workspace path
6. Add an edge only if that workspace path also exists in the current repo's
   `yaffle.toml`

This namespace check is what keeps cross-repo module references out of the DAG.
Two repos can both have a workspace at `infra/shared`, but only the matching
namespace is treated as an internal dependency.

### Same-Repo vs Cross-Repo Examples

```hcl
# apps/api/infra/main.tf

# Same repo -> becomes a DAG edge if infra/shared exists in this repo
module "shared" {
  source = "yaffle.dev/acme--app/infra--shared/yaffle"
}

# Cross repo -> registry dependency only, never a DAG edge in acme/app
module "cluster" {
  source = "yaffle.dev/acme--platform/platform--eks/yaffle"
}
```

### Dependency Graph

For same-repo references, Yaffle builds a DAG of workspace dependencies:

```
core-infrastructure/vpc
├── apps/api/infra
├── apps/web/infra
└── services/worker/infra

core-infrastructure/eks
├── apps/api/infra
└── services/worker/infra

apps/shared-lib/infra
└── apps/api/infra
```

Uses:
- Cycle detection
- Plan/apply ordering
- Blast radius analysis

### What Is Not in the DAG

- Cross-repo module references
- Cross-org module references, which are unsupported and denied by the registry
- Any non-Yaffle Terraform modules (`terraform-aws-modules/*`, git sources, local paths, etc.)

Those still resolve through Terraform/OpenTofu normally, but Yaffle does not
delay or sequence runs around them.

---

## Implementation Phases

### Phase 1: Module Registry Protocol (YAF-38)

Implement the Terraform module registry protocol:
- Service discovery (`modules.v1`)
- Version listing endpoint
- Module download endpoint
- Authentication (same as TFC API)

**Blocked by:** YAF-34 (State Versions API)

### Phase 2: Shim Module Generation (YAF-39)

Generate typed shim modules from workspace outputs:
- Extract outputs from state
- Infer HCL types
- Generate valid HCL module
- Cache in S3

**Blocked by:** YAF-38

### Phase 3: Preview-Aware Resolution (YAF-40)

Resolve modules to correct state based on context:
- Non-preview vs preview finalized state
- Last-known-good fallback when preview state is unavailable
- `?preview=pr-{n}` propagation through registry requests

**Blocked by:** YAF-39

### Phase 4: Dependency Inference and Validation (YAF-41)

Same-repo dependency management via Terraform source scanning:
- Infer edges from Yaffle module sources
- Keep only current-namespace references in the DAG
- Cycle detection
- Dependency graph API

**Blocked by:** YAF-38

---

## File Structure

### New Files

```
src/
├── routes/
│   └── tfc/
│       └── registry.ts              # Module registry endpoints
├── lib/
│   ├── module-generator.ts          # Shim module generation
│   ├── module-cache.ts              # S3 caching for generated modules
│   ├── type-inference.ts            # State type → HCL type
│   └── dependency-graph.ts          # Workspace dependency DAG
└── db/queries/
    └── workspace-deps.ts            # Dependency queries
```

### Modified Files

```
src/
├── routes/well-known.ts             # Add modules.v1 to discovery
├── lib/state-version-service.ts     # Extract outputs on upload
└── lib/config-parser.ts             # Parse uses/consumers
```

---

## Relationship to TFC State Backend

The Module Registry builds on top of the TFC State Backend:

```
┌─────────────────────────────────────┐
│       Yaffle Module Registry        │  ← This project
│  (YAF-38, YAF-39, YAF-40, YAF-41)  │
└─────────────────────────────────────┘
                  │
                  │ reads state_versions.outputs
                  │
                  ▼
┌─────────────────────────────────────┐
│     TFC-Compatible State Backend    │  ← Prerequisite
│  (YAF-31, YAF-32, YAF-33, YAF-34,  │
│   YAF-35, YAF-36)                  │
└─────────────────────────────────────┘
```

The state backend must be implemented first. The module registry is an
enhancement that provides a better developer experience for cross-workspace
dependencies.

---

## References

- [Terraform Module Registry Protocol](https://developer.hashicorp.com/terraform/internals/module-registry-protocol)
- [Terraform Remote State](https://developer.hashicorp.com/terraform/language/state/remote-state-data)
- [HCL Type System](https://developer.hashicorp.com/terraform/language/expressions/type-constraints)
