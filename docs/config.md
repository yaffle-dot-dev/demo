# Yaffle Configuration

Yaffle is configured via a `yaffle.toml` file in the root of your repository.

## Overview

The configuration defines:

- **Environments** - Named, long-lived deployment targets (e.g., `main`, `staging`)
- **Workspaces** - Terraform root modules and which environments they deploy to
- **Triggers** - What events cause Yaffle to run (pushes, pull requests)

## Example

```toml
version = 1

[[environments]]
name = "main"

[[environments]]
name = "staging"

[[workspaces]]
path = "infra/shared"
environments = ["main", "staging"]

[[workspaces]]
path = "infra/production"
environments = ["main"]

[[workspaces]]
path = "apps/control-plane/infra"
environments = ["*"]

[[triggers.github.push]]
branch = "main"
environment = "main"

[[triggers.github.push]]
branch = "staging"
environment = "staging"

[[triggers.github.pull_request]]
branch_pattern = "*"
```

## Reference

### `version`

**Required.** Configuration schema version. Currently must be `1`.

```toml
version = 1
```

### `[[environments]]`

Declares a named environment. Named environments are long-lived deployment targets tied to branches.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier for the environment |

```toml
[[environments]]
name = "main"

[[environments]]
name = "staging"

[[environments]]
name = "production"
```

### `[[workspaces]]`

Declares a Terraform workspace (root module) and specifies which environments it deploys to.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | Yes | Path to the Terraform root module, relative to repo root |
| `environments` | string or array | Yes | Which environments this workspace deploys to |

The `environments` field accepts:

- `["*"]` - All environments (named + transient)
- `["main", "staging"]` - Explicit list of named environments
- `"main"` - Single environment (shorthand for `["main"]`)

```toml
[[workspaces]]
path = "infra/shared"
environments = ["main", "staging"]

[[workspaces]]
path = "infra/production"
environments = "main"

[[workspaces]]
path = "apps/web/infra"
environments = ["*"]
```

**Validation:**

- `path` must be unique across all workspaces
- Environment names must reference declared `[[environments]]`, or be `"*"`
- Referencing an undeclared environment is an error

### `[[triggers.github.push]]`

Triggers a plan/apply cycle when a branch is pushed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | Yes | Branch name or glob pattern |
| `environment` | string | Yes | Named environment to deploy |

```toml
[[triggers.github.push]]
branch = "main"
environment = "main"

[[triggers.github.push]]
branch = "staging"
environment = "staging"

[[triggers.github.push]]
branch = "release/*"
environment = "release"
```

**Behavior:**

- When the specified branch is pushed, Yaffle runs `plan` then `apply` for all workspaces that include the named environment
- The `environment` must reference a declared `[[environments]]` name

**Glob patterns:**

- `*` matches any characters except `/`
- `release/*` matches `release/v1`, `release/hotfix`, etc.

### `[[triggers.github.pull_request]]`

Triggers a transient environment when a pull request is opened or updated.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch_pattern` | string | Yes | Glob pattern for the PR's head (source) branch |

```toml
[[triggers.github.pull_request]]
branch_pattern = "*"
```

**Behavior:**

- When a PR is opened from a branch matching `branch_pattern`, Yaffle creates a transient environment named `pr-{number}` (e.g., `pr-123`)
- Yaffle runs `plan` for all workspaces that include `"*"` in their environments
- Apply requires explicit approval
- When the PR is closed (merged or abandoned), Yaffle destroys the transient environment

**Glob patterns:**

- `*` matches any branch
- `feature/*` matches only branches starting with `feature/`

## Environments

Yaffle has two kinds of environments:

### Named Environments

Named environments are declared in `[[environments]]` and are long-lived. They represent deployment targets like `main`, `staging`, or `production`.

- Created when first triggered
- Never automatically destroyed (removed when deleted from config)
- Tied to specific branches via `[[triggers.github.push]]`

### Transient Environments

Transient environments are created automatically by triggers like `[[triggers.github.pull_request]]`. They are short-lived and tied to the lifecycle of their trigger source.

- Named automatically (e.g., `pr-123` for pull requests)
- Destroyed when the trigger source closes (e.g., PR merged or closed)
- Useful for preview/ephemeral infrastructure

## Validation

Yaffle validates your configuration on every run:

1. **Environment references** - Workspace `environments` and trigger `environment` must reference declared `[[environments]]` or use `"*"`
2. **Unique paths** - Workspace paths must be unique
3. **Trigger coverage** - Warning if a declared environment has no trigger
