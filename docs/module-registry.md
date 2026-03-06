# Yaffle Module Registry

Infrastructure as a Product - A TFC-compatible module registry that auto-generates
typed modules from workspace outputs.

## Overview

Platform teams publish infrastructure, app teams consume it like any Terraform module:

```hcl
module "vpc" {
  source = "yaffle.dev/acme/core-infrastructure/vpc"
}

resource "aws_security_group" "api" {
  vpc_id = module.vpc.vpc_id  # Typed! Autocomplete works!
}
```

### Key Benefits

- **Type safety**: Generated modules have typed outputs, IDE autocomplete works
- **No magic strings**: Reference infrastructure by module, not hardcoded IDs
- **Preview-aware**: Modules resolve to production or preview state as appropriate
- **Zero config for publishers**: Just write normal Terraform with outputs
- **Standard Terraform**: Uses native module syntax, no custom providers

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Terraform CLI                                   │
│    module "vpc" { source = "yaffle.dev/acme/core-infrastructure/vpc" }      │
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

Nothing changes. Write normal Terraform with outputs:

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
as a module at `yaffle.dev/<org>/core-infrastructure/vpc`.

### For App Teams (Consumers)

Reference infrastructure as modules:

```hcl
# apps/api/infra/main.tf
module "vpc" {
  source = "yaffle.dev/acme/core-infrastructure/vpc"
}

module "eks" {
  source = "yaffle.dev/acme/core-infrastructure/eks"
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

Module source `yaffle.dev/acme/core-infrastructure/vpc` maps to:

| Component | Value | Source |
|-----------|-------|--------|
| hostname | `yaffle.dev` | From module source |
| namespace | `acme` | Org slug |
| name | `core-infrastructure--vpc` | Workspace path (slashes → `--`) |
| provider | `yaffle` | Constant (not provider-specific) |

### List Versions

```http
GET /tfc/registry/v1/modules/acme/core-infrastructure--vpc/yaffle/versions
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
GET /tfc/registry/v1/modules/acme/core-infrastructure--vpc/yaffle/1.0.42/download
Authorization: Bearer <token>
```

Response:
```http
HTTP/1.1 204 No Content
X-Terraform-Get: /tfc/registry/v1/modules/acme/core-infrastructure--vpc/yaffle/1.0.42/archive.tar.gz
```

The archive contains the generated shim module.

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

When a preview workspace references a module, Yaffle resolves it appropriately.

### The Problem

```hcl
# apps/api/infra/main.tf (in PR #42)
module "vpc" {
  source = "yaffle.dev/acme/core-infrastructure/vpc"
}

module "shared" {
  source = "yaffle.dev/acme/apps/shared-lib/infra"
}
```

- `module.vpc` should use **production** state (can't duplicate VPC per PR)
- `module.shared` should use **preview** state if also modified in PR #42

### Resolution Algorithm

```
resolveModule(moduleSource, previewContext):
  workspacePath = parseWorkspacePath(moduleSource)
  
  if previewContext is null:
    return productionState(workspacePath)
  
  if workspacePath in previewContext.modifiedWorkspaces:
    previewState = getPreviewState(workspacePath, previewContext.prNumber)
    if previewState exists:
      return previewState
  
  return productionState(workspacePath)
```

### Preview Context

Pass preview context via query parameter:

```hcl
module "vpc" {
  source = "yaffle.dev/acme/core-infrastructure/vpc?preview=pr-42"
}
```

Or Yaffle injects this when generating the runner's Terraform config.

### Configuration

Explicit control in `.yaffle/config.yml`:

```yaml
workspaces:
  - path: apps/api/infra
    uses:
      - workspace: core-infrastructure/vpc
        preview: never    # Always use production
      - workspace: apps/shared-lib/infra
        preview: auto     # Use preview if in same PR (default)
      - workspace: apps/feature-flags/infra
        preview: always   # Always use preview (for testing)
```

| Setting | Behavior |
|---------|----------|
| `never` | Always resolve to production state |
| `auto` | Use preview if workspace modified in same PR |
| `always` | Always resolve to preview state (useful for feature flags) |

---

## Dependency Declaration

Workspaces declare dependencies in `.yaffle/config.yml`:

```yaml
workspaces:
  - path: apps/api/infra
    uses:
      - core-infrastructure/vpc
      - core-infrastructure/eks
      - apps/shared-lib/infra

  - path: core-infrastructure/vpc
    # Control who can consume this workspace
    consumers:
      - apps/*
      - services/*
```

### Validation

On PR/push, Yaffle validates:

1. **Dependency exists**: Referenced workspace must exist
2. **No cycles**: `A uses B uses A` is an error
3. **Consumer allowed**: If `consumers` is set, requestor must match

### Dependency Graph

Yaffle builds a DAG of workspace dependencies:

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

### Security Model

| Setting | Behavior |
|---------|----------|
| No `consumers` | Any workspace in org can use (MVP default) |
| `consumers: []` | No one can use (private) |
| `consumers: [apps/*]` | Only matching paths can use |

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
- Production vs preview state
- PR changeset detection
- `preview: never/auto/always` config

**Blocked by:** YAF-39

### Phase 4: Dependency Declaration (YAF-41)

Config-driven dependency management:
- `uses` declarations
- `consumers` allowlist
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
