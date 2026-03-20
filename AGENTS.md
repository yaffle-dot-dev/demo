# AGENTS.md - Yaffle

> Yaffle is a Terraform runner with ephemeral preview workspaces, triggered by
> GitHub webhook events. See PLAN.md for full architecture.

## How We Build Yaffle

**We dogfood Yaffle to build Yaffle.** This is non-negotiable.

Yaffle's value proposition is safe, incremental infrastructure delivery from 0 to
100 and from 100 to infinity. We prove this by using Yaffle to deploy itself.

### The Framework

1. **Every infrastructure change goes through a PR.** No manual `terraform apply`
   in production. No "just this once" exceptions.

2. **Preview environments validate changes before merge.** Open a PR, Yaffle spins
   up ephemeral infrastructure, runs plans, and shows you exactly what will change.
   See it working before you commit to it.

3. **Merge means deploy.** When the PR merges, Yaffle applies to production. The
   same plan you reviewed, the same state, no surprises.

4. **Build incrementally.** Small PRs, small changes, frequent deploys. Don't let
   infrastructure changes pile up into a terrifying mega-deploy.

### Why This Matters

- **We feel our own pain.** If Yaffle is annoying to use, we fix it immediately.
- **We prove the value prop.** Every successful deploy is evidence that Yaffle works.
- **We catch bugs early.** Dogfooding surfaces issues before customers hit them.
- **We build confidence.** Safe iteration from zero to production, every time.

### Practical Rules

- `apps/control-plane/infra/` contains Yaffle's own Terraform (S3 state bucket, etc.)
- `.yaffle/config.yml` configures Yaffle to manage itself
- PRs trigger preview plans via Yaffle
- Merges to `main` trigger production applies
- If Yaffle can't deploy Yaffle, we're not shipping

## Project Overview

- **Control Plane:** Hono + Bun (TypeScript) - `apps/control-plane/`
- **Frontend:** SvelteKit
- **Database:** Postgres (Neon initially, then RDS)
- **TF Execution:** ECS Fargate containers
- **State Storage:** S3 / DynamoDB
- **Secrets:** AWS Secrets Manager
- **VCS:** Git + Jujutsu (jj) colocated

## Security Requirements

Security is a core product requirement for Yaffle, not a polish pass. Future
changes MUST follow security best practices, especially for multi-tenant
isolation.

### Non-Negotiable Rules

- **Tenant isolation is mandatory.** Never ship a code path that allows a user,
  token, job, workspace, preview, run, state object, connection, or webhook
  action to cross org boundaries without an explicit, reviewed authorization
  check.
- **Every authenticated route must enforce authorization.** Authentication alone
  is never enough. Any route that accepts org IDs, slugs, workspace IDs, run IDs,
  state version IDs, connection IDs, or similar resource identifiers must verify
  the caller is authorized for the owning org/resource.
- **Deny by default.** If authorization context is missing, ambiguous, or cannot
  be proven, fail closed.
- **No fail-open security behavior in production.** Missing secrets, missing auth
  config, missing webhook secrets, or missing token scope configuration must
  reject requests rather than silently bypass checks.
- **Least privilege everywhere.** Tokens, IAM roles, runners, and internal
  services must only receive the minimum permissions they need. Do not introduce
  broad `*` scopes or shared credentials when narrower scoping is possible.
- **No secrets in logs, code, or persistent artifacts.** Never log tokens,
  session cookies, Authorization headers, connection secrets, presigned URLs, or
  Terraform state contents. Never commit secrets to the repo.
- **Prefer short-lived credentials.** Prefer expiring, scoped, auditable
  credentials over long-lived static secrets.
- **Security-sensitive changes require tests.** Any change touching auth,
  org membership, token issuance, state access, runners, webhooks, connections,
  or secrets must include positive and negative security test coverage.

### OWASP and Multi-Tenant Expectations

- **Broken access control:** Always check org/resource ownership on reads,
  writes, streaming endpoints, and background job callbacks.
- **Authentication failures:** Tokens must be scoped, expiring where practical,
  and never accepted through weaker transports unless explicitly designed for
  that purpose.
- **Security misconfiguration:** Production paths must fail closed. Dev-only
  bypasses must be explicit, narrowly scoped, and loudly documented in code.
- **Sensitive data exposure:** Treat Terraform state, outputs, connection
  secrets, OAuth tokens, API keys, and session material as highly sensitive.
- **DoS and abuse resistance:** Public endpoints should enforce request-size
  limits, rate limiting where appropriate, and avoid unbounded in-memory body
  buffering.

### Implementation Guidance

- Reuse shared authorization middleware/helpers instead of duplicating ad hoc
  checks in handlers.
- Validate both identity and tenancy for resource-by-ID endpoints.
- Use typed role checks for privileged actions like approvals, connection
  management, token management, and force-unlock behavior.
- Add audit logs for sensitive actions, but redact secrets and capability tokens.
- When introducing new external callbacks or upload URLs, treat them as bearer
  capabilities: make them unpredictable, short-lived, one-time-use where
  possible, and never casually log them.
- Schema and API changes should preserve defense in depth: database scoping,
  application authz, and infrastructure isolation should all align.

### Required Security Review Triggers

Perform an explicit security review whenever a change touches:

- auth/session/token code
- org membership or role logic
- TFC-compatible workspace/state APIs
- webhooks or OAuth flows
- runner authentication or job tokens
- connection secrets or credential resolution
- state storage, outputs, or module registry downloads
- new public endpoints, SSE auth, file uploads, or presigned/capability URLs

If a change affects any of the above, call out the tenant-isolation and authz
impact in the PR description.

## Repository Structure

```
yaffle/
├── apps/
│   ├── control-plane/     # Hono + Bun control plane
│   │   ├── src/           # TypeScript source
│   │   ├── infra/         # Control plane infrastructure (S3, DynamoDB, ECS, etc.)
│   │   └── drizzle/       # Database migrations
│   ├── web/               # SvelteKit frontend
│   └── runner/            # TF runner Docker container
├── modules/
│   └── aws-runner/        # BYOA module (future)
├── packages/
│   └── shared/            # Shared TypeScript packages
├── actions/
│   └── outputs-action/    # GitHub Action for fetching TF outputs
└── .yaffle/
    └── config.yml         # Self-dogfooding config
```

## Build / Lint / Test Commands

Package manager is **Bun**. All commands run from the repo root unless noted.

```bash
# First-time setup
./scripts/dev-init.sh         # Initialize postgres databases

# Development (process-compose manages all services)
process-compose up            # Start all services (postgres, caddy, apps)
process-compose up -t=false   # Start without TUI
process-compose down          # Stop all services

bun run dev:control-plane     # Run control plane only
bun run dev:web               # Run SvelteKit frontend only

# Install dependencies
bun install

# Build
bun run build                 # Build all packages
bun run build --filter=api    # Build a specific app

# Type checking
bun run typecheck             # Run tsc --noEmit across workspace

# Linting and formatting
bun run lint                  # Lint all packages
bun run lint --fix            # Auto-fix lint issues
bun run format                # Format with Biome/Prettier
bun run format --check        # Check formatting without writing

# Testing
bun test                      # Run all tests
bun test --filter=api         # Run tests for a specific workspace
bun test path/to/file.test.ts # Run a single test file
bun test --watch              # Watch mode
bun test -t "pattern"         # Run tests matching a name pattern

# Infrastructure
cd infra && terraform plan    # TF plan (local dev)
cd infra && terraform apply   # TF apply (local dev)
```

## Code Style Guidelines

### TypeScript Conventions

- **Strict mode:** Always enable `strict: true` in tsconfig.json.
- **No `any`:** Avoid `any`. Use `unknown` and narrow with type guards.
- **Explicit return types:** Always annotate return types on exported functions.
- **Prefer `const`:** Use `const` by default; `let` only when reassignment is needed.
- **No `var`:** Never use `var`.
- **Template literals:** Prefer template literals over string concatenation.

### Naming Conventions

- **Files:** `kebab-case.ts` for all TypeScript files (e.g., `webhook-handler.ts`).
- **Types/Interfaces:** `PascalCase` (e.g., `TerraformResult`, `PreviewStatus`).
- **Functions/Variables:** `camelCase` (e.g., `runTerraform`, `stateBucket`).
- **Constants:** `UPPER_SNAKE_CASE` for true constants (e.g., `MAX_RETRY_ATTEMPTS`).
- **Database columns:** `snake_case` matching the Postgres schema in PLAN.md.
- **Enums:** Prefer string union types over TypeScript enums.
  ```typescript
  type RunStatus = 'pending' | 'running' | 'success' | 'failed'
  ```

### Imports

- Use ES module `import`/`export` syntax exclusively. No CommonJS `require()`.
- Group imports in this order, separated by blank lines:
  1. Node/Bun built-ins (`node:fs`, `node:path`)
  2. External packages (`hono`, `drizzle-orm`, etc.)
  3. Internal packages (`@yaffle/shared`)
  4. Relative imports (`./lib/db`)
- Prefer named exports over default exports.
- Use `import type` for type-only imports.

### Formatting

- **Indentation:** 2 spaces (no tabs).
- **Semicolons:** Omit (no semicolons).
- **Quotes:** Double quotes for strings.
- **Trailing commas:** Always use trailing commas in multiline constructs.
- **Line length:** 100 characters soft limit.
- **Braces:** Same-line opening braces (1TBS style).

### Error Handling

- Use typed errors. Define domain-specific error types:
  ```typescript
  class YaffleError extends Error {
    constructor(message: string, public readonly code: string) {
      super(message)
      this.name = "YaffleError"
    }
  }
  ```
- Never swallow errors silently. Always log or propagate.
- Use `Result` patterns for expected failures (e.g., validation).
- Reserve `try/catch` for unexpected errors and external I/O boundaries.
- Return early on error conditions; avoid deep nesting.

### Hono API Conventions

- Use Hono's typed routes and middleware composition.
- Validate request bodies with Zod schemas.
- Return consistent JSON response shapes:
  ```typescript
  // Success
  { data: T }
  // Error
  { error: { code: string, message: string } }
  ```
- Use appropriate HTTP status codes (201 for creation, 409 for conflicts, etc.).

### Database

- Use Drizzle ORM (or chosen ORM) with typed schemas matching PLAN.md.
- All schema changes via migrations. Never modify the DB schema manually.
- Use parameterized queries. Never interpolate user input into SQL.
- Column names in `snake_case`, mapped to `camelCase` in TypeScript.

### Testing

- Test files live alongside source: `foo.ts` -> `foo.test.ts`.
- Use `bun:test` (built-in Bun test runner).
- Prefer small, focused unit tests. Integration tests for API routes.
- Name tests descriptively: `"returns 404 when preview does not exist"`.
- Use factories/fixtures for test data rather than inline object literals.

### Git / Version Control

- This repo uses **Jujutsu (jj)** colocated with Git. Either tool works.
- Commit messages: imperative mood, lowercase, no period.
  ```
  add webhook handler for PR events
  fix state cleanup on PR close
  ```
- Keep commits atomic: one logical change per commit.
- Branch naming: `feature/description`, `fix/description`.

### Terraform / HCL

- Files in `infra/` follow standard Terraform conventions.
- Use `snake_case` for all resource names and variables.
- Tag all AWS resources with `project = "yaffle"` and `environment`.
- Pin provider versions in `versions.tf`.

### Docker

- Runner container in `apps/runner/`.
- Use multi-stage builds to minimize image size.
- Never bake secrets into images.
- Pin base image versions (e.g., `hashicorp/terraform:1.7`).

## Key Domain Concepts

- **Preview:** An ephemeral Terraform workspace tied to a PR.
- **Run:** A single `plan`, `apply`, or `destroy` execution.
- **Connection:** Credentials for a target system (Grafana, AWS, etc.).
- **Codegen:** Generating Terraform from source files (JSON -> HCL).
- **State key pattern:** `previews/pr-{n}/terraform.tfstate` or
  `production/main/terraform.tfstate`.
