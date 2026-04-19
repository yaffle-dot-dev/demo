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
ref_patterns = ["refs/heads/main"]
environment = "main"

[[triggers.github.push]]
ref_patterns = ["refs/heads/staging"]
environment = "staging"

[[triggers.github.pull_request]]
branch_patterns = ["*"]
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

Triggers a plan/apply cycle when a ref is pushed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ref_patterns` | array | Yes | Include globs for full refs |
| `exclude_ref_patterns` | array | No | Exclude globs applied after include matching |
| `environment` | string | Yes | Named environment to deploy |

```toml
[[triggers.github.push]]
ref_patterns = ["refs/heads/main"]
environment = "main"

[[triggers.github.push]]
ref_patterns = ["refs/heads/staging"]
environment = "staging"

[[triggers.github.push]]
ref_patterns = ["refs/heads/release/*"]
exclude_ref_patterns = ["refs/heads/release/archive/**"]
environment = "release"
```

**Behavior:**

- When a pushed ref matches any `ref_patterns` entry and none of the `exclude_ref_patterns` entries, Yaffle runs `plan` then `apply` for all workspaces that include the named environment
- The `environment` must reference a declared `[[environments]]` name

**Glob patterns:**

- `*` matches any characters except `/`
- `**` matches across `/`
- `refs/heads/release/*` matches `refs/heads/release/v1`, `refs/heads/release/hotfix`, etc.

Legacy `ref = "refs/heads/main"` remains supported as shorthand for a single include pattern.

### `[[triggers.github.pull_request]]`

Triggers a transient environment when a pull request is opened or updated.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch_patterns` | array | Yes | Include globs for the PR's head (source) branch |
| `exclude_branch_patterns` | array | No | Exclude globs applied after include matching |

```toml
[[triggers.github.pull_request]]
branch_patterns = ["*"]
exclude_branch_patterns = ["dependabot/**"]
```

**Behavior:**

- When a PR is opened from a branch matching any `branch_patterns` entry and none of the `exclude_branch_patterns` entries, Yaffle creates a transient environment named `pr-{number}` (e.g., `pr-123`)
- Yaffle runs `plan` for all workspaces that include `"*"` in their environments
- Apply requires explicit approval
- When the PR is closed (merged or abandoned), Yaffle destroys the transient environment

**Glob patterns:**

- `*` matches any branch
- `feature/*` matches only branches starting with `feature/`
- `dependabot/**` matches `dependabot/` branches at any depth

Legacy `branch_pattern = "*"` remains supported as shorthand for a single include pattern.

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
