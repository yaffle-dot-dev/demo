# AGENTS.md - Yaffle

> Yaffle is a Terraform runner with ephemeral preview workspaces, triggered by
> GitHub webhook events. See PLAN.md for full architecture.

## Project Overview

- **Control Plane API:** Hono + Bun (TypeScript)
- **Frontend:** SvelteKit
- **Database:** Postgres (Neon initially, then RDS)
- **TF Execution:** ECS Fargate containers
- **State Storage:** S3 / DynamoDB
- **Secrets:** AWS Secrets Manager
- **VCS:** Git + Jujutsu (jj) colocated

## Repository Structure

```
yaffle/
├── infra/                 # Yaffle's own Terraform (dogfooded)
├── apps/
│   ├── api/               # Hono + Bun control plane (src/)
│   ├── web/               # SvelteKit frontend
│   └── runner/            # TF runner Docker container
├── modules/
│   └── aws-runner/        # BYOA module (future)
├── packages/
│   └── shared/            # Shared TypeScript packages
└── .yaffle/
    └── config.yml         # Self-dogfooding config
```

## Build / Lint / Test Commands

Package manager is **Bun**. All commands run from the repo root unless noted.

```bash
# Install dependencies
bun install

# Development
bun run dev:api               # Run API locally
bun run dev:web               # Run SvelteKit frontend

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
