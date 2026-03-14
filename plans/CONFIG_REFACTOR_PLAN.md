# Config Refactor Plan

Refactor Yaffle's data model from `prNumber`-based discrimination to explicit
`environment`/`environment_kind` semantics, and migrate from YAML to TOML config.

## Status

**Completed:**
- ✅ Phase 1: TOML Config Parser (basic schema)
- ✅ Phase 2: Database Schema Changes
- ✅ Phase 3: Query Migration
- ✅ Phase 4-5: Webhook Handler & IAC Engine
- ✅ Phase 6: Event System
- ✅ Phase 7: API Routes
- ✅ Phase 8: Frontend Changes
- ✅ Phase 9: Cleanup
- ✅ Phase 10: Extended TOML schema (approvals, variables, glob matching)
- ✅ Phase 11: Webhook handler migrated to TOML
- ✅ Phase 12: IAC engine migrated to TOML
- ✅ Phase 13: YAML code removed
- ✅ Phase 14: Variable templating with minijinja-js
- ✅ Phase 15: Namespaced approver syntax

**Status: COMPLETE** 🎉

---

## Final Config Schema

### Example `yaffle.toml`

```toml
version = 1

# =============================================================================
# Environments
# =============================================================================

[[environments]]
name = "main"

[[environments]]
name = "staging"

# =============================================================================
# Triggers
# =============================================================================

[[triggers.github.push]]
branch = "main"
environment = "main"

[[triggers.github.push]]
branch = "staging"
environment = "staging"

[[triggers.github.pull_request]]
branch_pattern = "*"

# =============================================================================
# Workspaces
# =============================================================================

[[workspaces]]
path = "infra/shared"
environments = ["main", "staging"]
variables.cloudflare_zone_id = "abc123"

[[workspaces]]
path = "infra/production"
environments = ["main"]

[[workspaces]]
path = "apps/control-plane/infra"
environments = ["*"]
variables.domain = "{{ environment }}.yaffle.dev"

# =============================================================================
# Approvals
# =============================================================================

[[approvals]]
workspaces = ["infra/production", "infra/shared"]
environments = ["main"]
approvers = [
  "github:user:alice",
  "github:user:bob",
  "github:team:yaffle-dot-dev/platform-engineering",
]

[[approvals]]
workspaces = ["infra/*"]
environments = ["staging"]
approvers = ["github:team:yaffle-dot-dev/infra-team"]
```

---

## TypeScript Schema

```typescript
interface YaffleConfig {
  version: 1
  environments: Environment[]
  workspaces: Workspace[]
  triggers: Triggers
  approvals?: Approval[]
}

interface Environment {
  name: string
}

interface Workspace {
  path: string
  environments: string[] | "*"
  variables?: Record<string, string | number | boolean>
}

interface Triggers {
  github?: GitHubTriggers
}

interface GitHubTriggers {
  push?: PushTrigger[]
  pull_request?: PullRequestTrigger[]
}

interface PushTrigger {
  branch: string           // branch name or glob pattern
  environment: string      // must reference declared environment
}

interface PullRequestTrigger {
  branch_pattern: string   // glob pattern for head branch
}

interface Approval {
  workspaces: string[]     // paths or globs, "*" for all
  environments: string[]   // named env names, "*" includes transients
  approvers: string[]      // Namespaced identifiers (e.g., "github:user:alice")
}
```

---

## Approval Semantics

1. **Matching**: Multiple `[[approvals]]` blocks can match a workspace/environment pair
2. **Union**: All matching rules are combined (union of approvers)
3. **Any approver**: Any single approver from the combined list can approve
4. **Empty approvers**: An empty `approvers = []` array means no approval required (semantically equivalent to no matching approval rules)
5. **Globs**: `workspaces` supports glob patterns where `*` matches any path segments until the next literal:
   - `infra/*` matches `infra/foo`, `infra/foo/bar/baz`, etc.
   - `infra/*/production` matches `infra/anything/here/production` but not `infra/foo/nonproduction`
6. **Transients**: Use `environments = ["*"]` to require approval for transient environments (not recommended, but supported)
7. **Redundancy**: `["main", "*"]` is redundant but not an error

### Future Extensions (non-breaking)

```toml
[[approvals]]
workspaces = ["infra/production"]
environments = ["main"]
approvers = ["github:user:alice", "github:user:bob", "github:user:carol"]
required = 2        # any 2 of 3 must approve (default: 1)
# required = "all"  # all must approve
```

---

## Approver Syntax

Approvers use a namespaced format to support multiple identity providers:

```
<provider>:<type>:<identifier>
```

### Supported Providers

#### `github` Provider

| Type | Identifier | Example |
|------|------------|---------|
| `user` | username (lowercase) | `github:user:lamalex` |
| `team` | org/team-slug (lowercase) | `github:team:yaffle-dot-dev/platform-engineering` |

**Examples:**
```toml
approvers = [
  "github:user:alice",
  "github:user:bob",
  "github:team:yaffle-dot-dev/platform-engineering",
]
```

### Parsing Rules

1. **Format**: Exactly three colon-separated segments for users, org/team for teams
2. **Case**: All identifiers normalized to lowercase on parse
3. **Cross-org teams**: Allowed (team org doesn't need to match repo org)
4. **Validation**: Config parsing fails with clear error on invalid format

### Authorization

- **`github:user:X`**: Match if authenticated user's GitHub username equals X
- **`github:team:org/team`**: Match if authenticated user is an active member of the team (checked via GitHub API)

### Error Handling

- **Team membership check failure**: Retry with exponential backoff, fail closed after exhausting retries
- **Invalid approver format**: Config parsing fails with descriptive error

### Future Providers (Planned)

| Provider | Type | Example |
|----------|------|---------|
| `gitlab` | `user` | `gitlab:user:alice` |
| `gitlab` | `group` | `gitlab:group:yaffle/platform` |
| `yaffle` | `team` | `yaffle:team:platform-engineering` |
| `yaffle` | `role` | `yaffle:role:admin` |
| `oidc` | `group` | `oidc:group:engineering` |
| `aws` | `role` | `aws:role:123456789012:AdministratorAccess` |

### UI Display

Approvers are parsed and rendered with provider-specific formatting:
- **`github:user:X`**: Linked to `https://github.com/X` with user avatar
- **`github:team:org/team`**: Linked to `https://github.com/orgs/org/teams/team` with team icon

Each provider implements its own display logic for links and icons.

---

## Variable Semantics

1. **Workspace-level**: Variables are defined per-workspace, same for all environments
2. **Types**: Variables support `string | number | boolean` values
3. **TOML syntax**: Authors can use any valid TOML syntax:
   - Inline: `variables = { key = "value" }`
   - Dotted: `variables.key = "value"`
   - Multi-line inline: `variables = { \n key = "value", \n }`
4. **Templating**: String values can contain template expressions (e.g., `"{{ environment }}.yaffle.dev"`)
5. **Injected variables**: Yaffle always injects these Terraform variables:
   - `var.environment` - environment name
   - `var.environment_kind` - "named" | "transient"
   - `var.org` - org slug
   - `var.repo` - repo name
   - `var.workspace_path` - workspace path
   - `var.branch` - branch name
   - `var.commit_sha` - commit SHA
   - `var.pr_number` - PR number (`null` for named environments)

### Templating Language: minijinja

**Library**: `minijinja-js` (WASM bindings to Rust minijinja)

**Why minijinja:**
- Jinja2 syntax (industry standard, used by Ansible, dbt, Salt, etc.)
- Rich built-in filters (`lower`, `upper`, `replace`, `truncate`, `default`, `trim`, etc.)
- Fast (Rust compiled to WASM)
- Future-proof: same engine if Yaffle ports to Rust

**Syntax:**
```toml
# Simple substitution
variables.domain = "{{ environment }}.yaffle.dev"

# With filters
variables.bucket = "{{ org | lower }}-{{ repo | replace('/', '-') }}-{{ environment }}"
variables.short_sha = "{{ commit_sha | truncate(7) }}"

# Literal braces (two options)
variables.escaped = "Literal: {{ '{{' }} and {{ '}}' }}"
variables.raw_block = "{% raw %}{{ not processed }}{% endraw %}"
```

**Template context:**
- `environment` - environment name (e.g., "main", "pr-123")
- `environment_kind` - "named" | "transient"
- `org` - org slug
- `repo` - repo name
- `branch` - branch name
- `commit_sha` - full commit SHA
- `pr_number` - PR number (`null` for named environments)

**Error handling:**
- Unknown variables → fail the workspace run
- Syntax errors → fail the workspace run
- Clear error messages with context

**Useful built-in filters:**

| Filter | Example | Output |
|--------|---------|--------|
| `lower` | `{{ "FOO" \| lower }}` | `foo` |
| `upper` | `{{ "foo" \| upper }}` | `FOO` |
| `replace` | `{{ "a/b" \| replace("/", "-") }}` | `a-b` |
| `truncate` | `{{ "abcdef" \| truncate(3) }}` | `abc` |
| `default` | `{{ missing \| default("fallback") }}` | `fallback` |
| `trim` | `{{ " foo " \| trim }}` | `foo` |
| `join` | `{{ ["a","b"] \| join("-") }}` | `a-b` |

---

## Removed Features

The following YAML config features are **removed** (not migrated to TOML):

| Feature | Reason |
|---------|--------|
| `auto_apply` | Unnecessary complexity |
| `auto_apply_on_merge` | Unnecessary complexity |
| `on_apply` callbacks | Use GitHub Action instead |
| `default_branch` | Inferred from triggers |

---

## Remaining Implementation Tasks

### Phase 10: Extend TOML Schema

**File**: `apps/control-plane/src/lib/config-toml.ts`

1. Add `variables` field to workspace schema (support `string | number | boolean`)
2. Add `[[approvals]]` section schema
3. Add validation:
   - Approval `workspaces` must be valid globs or `"*"`
   - Approval `environments` must reference declared envs or be `"*"`
   - Empty `approvers` array is allowed (means no approval required)
4. Add glob matching for workspace patterns (`*` matches any segments until next literal)
5. Add function to resolve approvers for a workspace/environment pair
6. Add workspace path validation (check paths exist in repo, surface clear per-workspace errors)

### Phase 11: Migrate Webhook Handler to TOML

**File**: `apps/control-plane/src/lib/webhook-handler.ts`

1. Change `fetchConfig()` to load `yaffle.toml` instead of `.yaffle/config.yml`
2. Update config type from `YaffleConfig` (YAML) to `YaffleTomlConfig`
3. Remove usage of removed fields:
   - `auto_apply` / `auto_apply_on_merge`
   - `default_branch`
4. Use `getWorkspacesForEnvironment()` from config-toml.ts
5. Resolve approvers using new approval resolution function

### Phase 12: Migrate IAC Engine

**File**: `apps/control-plane/src/lib/iac-engine.ts`

1. Update config loading to use TOML
2. Update variable injection to use workspace `variables` field
3. Implement variable templating (or pass through raw for now)

### Phase 13: Remove YAML Code

**Files to modify/delete:**
- `apps/control-plane/src/lib/config.ts` - Remove YAML parser, keep shared types
- `apps/control-plane/src/lib/config-parser.ts` - Remove if fully replaced
- `apps/control-plane/src/lib/config.test.ts` - Update tests
- `apps/control-plane/src/lib/local-runner.ts` - Update error messages
- `apps/control-plane/src/routes/dependencies.ts` - Update references
- `package.json` - Remove `yaml` dependency if unused

### Phase 14: Variable Templating

**Dependency**: `minijinja-js` (npm package - WASM bindings to Rust minijinja)

**File**: `apps/control-plane/src/lib/templating.ts`

Config parsing is server-side only, so no bundle size concerns with WASM.

1. Add `minijinja-js` dependency to control-plane
2. Create `renderTemplate(template: string, context: TemplateContext): string`
3. Define `TemplateContext` interface matching injected variables (`pr_number` is `null` for named envs)
4. Integrate into variable injection in `iac-engine.ts`
5. Handle errors: wrap minijinja errors with workspace context for clear messages
6. Add tests for:
   - Simple substitution
   - Filter usage (`lower`, `replace`, `truncate`, etc.)
   - Chained filters
   - Unknown variable (should fail)
   - Syntax error (should fail)
   - Literal brace escaping (`{{ '{{' }}`)

### Phase 15: Namespaced Approver Syntax

Replace plain username approvers with explicit `<provider>:<type>:<identifier>` syntax.

**New file**: `apps/control-plane/src/lib/approver.ts`

1. Define approver types:
   ```typescript
   interface GitHubUserApprover {
     provider: "github"
     type: "user"
     username: string  // lowercase
   }
   
   interface GitHubTeamApprover {
     provider: "github"
     type: "team"
     org: string       // lowercase
     team: string      // lowercase
   }
   
   type Approver = GitHubUserApprover | GitHubTeamApprover
   ```

2. Implement parsing:
   - `parseApprover(raw: string): Approver` - parse and normalize to lowercase
   - `serializeApprover(approver: Approver): string` - serialize back
   - `isValidApproverString(raw: string): boolean` - for Zod validation

3. Implement authorization:
   - `isUserAuthorizedApprover(approvers: string[], context): Promise<boolean>`
   - For `github:team:`, call GitHub API with retry + exponential backoff
   - Fail closed after exhausting retries

**File**: `apps/control-plane/src/lib/github.ts`

4. Add team membership check:
   ```typescript
   async function checkTeamMembership(
     installationId: number,
     org: string,
     team: string,
     username: string,
   ): Promise<boolean>
   ```
   - Uses `GET /orgs/{org}/teams/{team_slug}/memberships/{username}`
   - Returns `true` if membership state is "active"

**File**: `apps/control-plane/src/lib/config-toml.ts`

5. Update schema validation:
   - Add Zod refinement using `isValidApproverString()`
   - Clear error message for invalid format

**File**: `apps/control-plane/src/routes/previews.ts`

6. Update approval endpoint:
   - Replace string comparison with `isUserAuthorizedApprover()`
   - Pass `installationId` for team membership checks

**Tests**: `apps/control-plane/src/lib/approver.test.ts`

7. Write tests:
   - Parse valid `github:user:alice`
   - Parse valid `github:team:org/team`
   - Normalize to lowercase
   - Error on unknown provider
   - Error on unknown type
   - Error on malformed team (missing `/`)
   - Error on empty segments
   - Round-trip serialize/parse
   - Authorization for user match
   - Authorization for team membership (mocked)

**Update test fixtures**:

8. Update all test configs to use new syntax:
   - `apps/control-plane/src/lib/webhook-handler.test.ts`
   - `apps/control-plane/src/lib/config-toml.test.ts`

---

## Migration Checklist

- [x] Phase 1-9: Core refactor (environment_kind, environment_name, etc.)
- [x] Phase 10: Extend TOML schema
  - [x] Add `variables` to workspace schema (string | number | boolean)
  - [x] Add `[[approvals]]` schema
  - [x] Add glob matching (`*` matches any segments until next literal)
  - [x] Add approval resolution function
  - [x] Add workspace path validation (clear per-workspace errors)
  - [x] Write tests
- [x] Phase 11: Migrate webhook handler
  - [x] Change config file path to `yaffle.toml`
  - [x] Update type imports
  - [x] Remove usage of deleted fields
  - [x] Integrate approval resolution
  - [x] Update tests
- [x] Phase 12: Migrate IAC engine
  - [x] Update config loading
  - [x] Update variable injection
- [x] Phase 13: Remove YAML code
  - [x] Delete YAML parser files (config.ts, config-parser.ts, apply-callbacks.ts)
  - [x] Update error messages (local-runner.ts)
  - [x] Update dependencies route to use TOML
  - [x] Delete old test files
- [x] Phase 14: Variable templating
  - [x] Add `minijinja-js` dependency
  - [x] Create `templating.ts` with `renderTemplate()` and `renderVariables()` functions
  - [x] Define `TemplateContext` interface
  - [x] Integrate into `iac-engine.ts` variable injection with template rendering
  - [x] Integrate into `webhook-handler.ts` `buildWorkspaceVariables()` function
  - [x] Write tests (substitution, filters, errors, undefined variables)
- [x] Phase 15: Namespaced approver syntax
  - [x] Create `approver.ts` with types, parsing, serialization
  - [x] Add `isValidApproverString()` for Zod validation
  - [x] Add `checkTeamMembership()` to `github.ts`
  - [x] Add retry with backoff for team membership checks
  - [x] Implement `isUserAuthorizedApprover()` authorization
  - [x] Update `config-toml.ts` schema with validation refinement
  - [x] Update `previews.ts` approval endpoint
  - [x] Write tests for approver module (40 tests)
  - [x] Update all test fixtures with new syntax
  - [x] Update example configs in documentation
