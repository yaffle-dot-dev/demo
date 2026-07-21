# TFC-Compatible State Backend

This document describes Yaffle's Terraform Cloud (TFC) compatible state backend
implementation. This enables users to use Yaffle as their remote state host with
native Terraform CLI integration.

## Overview

Yaffle implements a subset of the TFC/TFE API to act as a remote state backend.
Users authenticate via `terraform login` and configure their Terraform projects
to use Yaffle as the state host.

### Protocol Example

This is a maintainer-facing protocol example, not the public setup guide.

```bash
# One-time authentication (production)
terraform login yaffle.dev

# Or for local development
terraform login localhost:3000

# In terraform configuration
terraform {
  cloud {
    hostname     = "yaffle.dev"  # or localhost:3000
    organization = "acme"

    workspaces {
      name = "pr-42-control-plane-infra"
    }
  }
}

# Normal terraform workflow
terraform init
terraform plan
terraform apply
```

### Deployment Model

The TFC-compatible API is **not a separate service**. It's a set of additional
routes in the existing Hono control plane, namespaced under `/tfc/`:

```
yaffle.dev (reverse proxy / CDN)
├── /                               # Web frontend (SvelteKit)
├── /.well-known/terraform.json     # Service discovery → points to /tfc/...
├── /tfc/oauth/authorize            # CLI OAuth flow (NEW)
├── /tfc/oauth/token                # CLI token exchange (NEW)
├── /tfc/api/v2/workspaces/...      # TFC workspace API (NEW)
├── /tfc/api/v2/state-versions/...  # TFC state API (NEW)
├── /api/webhooks/...               # GitHub webhooks (EXISTING)
├── /api/previews/...               # Preview management (EXISTING)
├── /api/orgs/...                   # Org management (EXISTING)
└── /api/auth/...                   # BetterAuth (EXISTING)
```

The reverse proxy routes:

- `/tfc/*` and `/api/*` → Control plane (Hono)
- `/.well-known/*` → Control plane (Hono)
- `/*` → Web frontend (SvelteKit)

This keeps deployment simple and allows sharing authentication, database
connections, and S3 clients.

**Future extraction:** The `/tfc/` namespace creates a clean seam. If scaling
requires it, the TFC API can be extracted into its own service - just update
the reverse proxy to route `/tfc/*` to the new service. From Terraform's
perspective, nothing changes (same hostname, paths, and tokens).

### Key Benefits

- **Native integration**: Uses Terraform's built-in `cloud` block, no custom backends
- **Centralized state**: All state managed by Yaffle with full version history
- **Audit trail**: Every state change linked to runs, users, and PRs
- **Automatic workspace management**: Workspaces created from `yaffle.toml`
- **Secure by default**: Short-lived tokens, workspace-scoped access

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Terraform CLI                                   │
│    terraform login yaffle.dev                                                │
│    terraform { cloud { hostname = "yaffle.dev" } }                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         yaffle.dev (Control Plane)                           │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Service Discovery & Auth                            │  │
│  │  GET /.well-known/terraform.json  →  { "tfe.v2.1": "/tfc/api/v2/" }   │  │
│  │  GET /tfc/oauth/authorize         →  OAuth authz (GitHub via BA)      │  │
│  │  POST /tfc/oauth/token            →  Issue API token                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         TFC-Compatible API                             │  │
│  │  GET  /tfc/api/v2/organizations/:org/workspaces/:name                 │  │
│  │  POST /tfc/api/v2/workspaces/:id/actions/lock                         │  │
│  │  POST /tfc/api/v2/workspaces/:id/actions/unlock                       │  │
│  │  POST /tfc/api/v2/workspaces/:id/state-versions                       │  │
│  │  GET  /tfc/api/v2/workspaces/:id/current-state-version                │  │
│  │  PUT  /tfc/api/v2/state-versions/:id/upload                           │  │
│  │  GET  /tfc/api/v2/state-versions/:id/download                         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                      │                                       │
│                                      ▼                                       │
│  ┌─────────────────────┐    ┌────────────────────────────────────────────┐  │
│  │      Postgres       │    │                    S3                       │  │
│  │  ────────────────   │    │  ──────────────────────────────────────    │  │
│  │  workspaces         │    │  {workspace_id}/v{serial}.tfstate          │  │
│  │  state_versions     │    │  {workspace_id}/v{serial}.tfstate.json     │  │
│  │  api_tokens         │    │                                            │  │
│  └─────────────────────┘    └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### `workspaces`

Represents a Terraform workspace managed by Yaffle.

```sql
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,                           -- "pr-42-control-plane-infra"
  repo TEXT NOT NULL,                           -- "acme/webapp"
  workspace_path TEXT NOT NULL,                 -- "apps/control-plane/infra"
  environment TEXT NOT NULL,                    -- "preview" | "production"
  pr_number INTEGER,                            -- null for production
  branch TEXT NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  locked_by TEXT,                               -- "user:{id}" or "run:{id}"
  locked_at TIMESTAMPTZ,
  lock_reason TEXT,
  current_state_version_id UUID,                -- FK added after state_versions exists
  terraform_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, name)
);
```

**Naming convention**: `{environment}-{identifier}-{workspace_path_slug}`

- GitHub PR environment: public name `pr-42`; TFC workspace `pr-42-control-plane-infra`
- Other transient sources use their canonical environment name in the same pattern
- Production: `production-main-control-plane-infra`

### `state_versions`

Stores metadata for each version of Terraform state.

```sql
CREATE TABLE state_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  serial INTEGER NOT NULL,
  lineage UUID,
  md5 TEXT NOT NULL,                            -- hex-encoded MD5 of state
  size INTEGER NOT NULL,                        -- bytes
  s3_key TEXT NOT NULL,                         -- path in S3 bucket
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | finalized | discarded
  terraform_version TEXT,
  resources JSONB,                              -- extracted resource summary
  outputs JSONB,                                -- extracted outputs (sensitive redacted)
  resources_processed BOOLEAN NOT NULL DEFAULT FALSE,
  run_id UUID REFERENCES tf_runs(id),           -- link to triggering run
  created_by TEXT,                              -- user_id or "run:{id}"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_state_versions_workspace ON state_versions(workspace_id);
CREATE INDEX idx_state_versions_serial ON state_versions(workspace_id, serial DESC);
```

**S3 key structure**: `{workspace_id}/v{serial}.tfstate`

### `api_tokens`

Long-lived tokens for CLI authentication (from `terraform login`).

```sql
CREATE TABLE api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  description TEXT,
  token_hash TEXT NOT NULL,                     -- bcrypt hash
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);
```

---

## Authentication

Yaffle supports two authentication methods for the TFC API:

### 1. User API Tokens (CLI)

Issued via `terraform login` OAuth flow. Long-lived, stored in `api_tokens` table.

**Flow:**

1. User runs `terraform login terraform.yaffle.dev`
2. CLI fetches `/.well-known/terraform.json` for OAuth config
3. CLI opens browser to `/oauth/authorize?client_id=terraform-cli&...`
4. Yaffle redirects to GitHub OAuth (via BetterAuth) if not logged in
5. User authenticates, sees consent screen
6. Yaffle redirects to CLI's localhost callback with auth code
7. CLI exchanges code for token via `POST /oauth/token`
8. Token stored in `~/.terraform.d/credentials.tfrc.json`

**Token format**: Opaque random string, bcrypt-hashed in database.

### 2. Run Tokens (Automated)

Stateless JWTs for automated runs. Not stored in database.

**Issuance**: When Yaffle starts a run, it generates a JWT:

```json
{
  "sub": "run:run-uuid",
  "workspace_id": "ws-uuid",
  "org_id": "org-uuid",
  "scopes": ["state:read", "state:write", "workspace:lock"],
  "iat": 1709654400,
  "exp": 1709672400
}
```

**Injection**: Token provided to runner via environment variable:

```bash
TF_TOKEN_yaffle_dev=<jwt>
```

**Validation**: Two checks are performed:

1. Verify JWT signature and expiry (stateless)
2. Check that the run is still active (database lookup)

The second check means tokens are effectively invalidated when the run
completes - no explicit token deletion needed.

**TTL**: 4 hours as a safety net for edge cases (control plane crash, network
partition). In practice, tokens stop working immediately when the run ends
because the run status check fails.

### Auth Middleware

All `/api/v2/*` endpoints use Bearer token auth:

```http
Authorization: Bearer <token>
```

The middleware:

1. Extracts token from header
2. If JWT format: validate signature, check expiry, extract claims
3. If opaque format: hash and lookup in `api_tokens` table
4. Attach user/run context to request

---

## Service Discovery

Terraform CLI discovers Yaffle's capabilities via:

### `GET /.well-known/terraform.json`

```json
{
  "tfe.v2": "/tfc/api/v2/",
  "tfe.v2.1": "/tfc/api/v2/",
  "tfe.v2.2": "/tfc/api/v2/",
  "login.v1": {
    "client": "terraform-cli",
    "grant_types": ["authz_code"],
    "authz": "/tfc/oauth/authorize",
    "token": "/tfc/oauth/token",
    "ports": [10000, 10010]
  }
}
```

**Service identifiers:**

- `tfe.v2`, `tfe.v2.1`, `tfe.v2.2`: TFC API versions (all point to `/tfc/api/v2/`)
- `login.v1`: OAuth configuration for `terraform login`

**OAuth config:**

- `client`: Client ID (advisory only, Terraform is a public client)
- `grant_types`: Only `authz_code` (authorization code grant with PKCE)
- `authz`: Authorization endpoint (`/tfc/oauth/authorize`)
- `token`: Token exchange endpoint (`/tfc/oauth/token`)
- `ports`: Allowed ports for CLI's localhost redirect (10000-10010)

---

## API Endpoints

All TFC API endpoints are namespaced under `/tfc/api/v2/`.

### Workspace Management

#### List Workspaces

```http
GET /tfc/api/v2/organizations/:org_name/workspaces
```

#### Get Workspace by Name

```http
GET /tfc/api/v2/organizations/:org_name/workspaces/:name
```

#### Get Workspace by ID

```http
GET /tfc/api/v2/workspaces/:workspace_id
```

#### Lock Workspace

```http
POST /tfc/api/v2/workspaces/:workspace_id/actions/lock
Content-Type: application/vnd.api+json

{
  "reason": "Running terraform plan"
}
```

**Response (200):**

```json
{
  "data": {
    "id": "ws-xxx",
    "type": "workspaces",
    "attributes": {
      "locked": true,
      "locked-reason": "Running terraform plan"
    }
  }
}
```

**Error (409 Conflict):** Workspace already locked by another user/run.

#### Unlock Workspace

```http
POST /tfc/api/v2/workspaces/:workspace_id/actions/unlock
```

Only the lock holder can unlock. Use `force-unlock` to override.

#### Force Unlock

```http
POST /tfc/api/v2/workspaces/:workspace_id/actions/force-unlock
```

Requires admin permissions on the workspace.

### State Versions

#### Create State Version

```http
POST /tfc/api/v2/workspaces/:workspace_id/state-versions
Content-Type: application/vnd.api+json

{
  "data": {
    "type": "state-versions",
    "attributes": {
      "serial": 42,
      "md5": "d41d8cd98f00b204e9800998ecf8427e",
      "lineage": "871d1b4a-e579-fb7c-ffdb-f0c858a647a7"
    }
  }
}
```

**Response (201):**

```json
{
  "data": {
    "id": "sv-xxx",
    "type": "state-versions",
    "attributes": {
      "serial": 42,
      "status": "pending",
      "hosted-state-upload-url": "/tfc/api/v2/state-versions/sv-xxx/upload",
      "created-at": "2024-03-06T12:00:00Z"
    }
  }
}
```

**Preconditions:**

- Workspace must be locked by the caller
- Serial must be greater than current state version's serial

#### Upload State

```http
PUT /tfc/api/v2/state-versions/:state_version_id/upload
Content-Type: application/octet-stream
Content-MD5: <base64-encoded-md5>

<raw state bytes>
```

**Response (200):** Empty body, state version status set to `finalized`.

**Validation:**

- Content-MD5 header must match body
- MD5 must match the value provided at creation

#### Get Current State Version

```http
GET /tfc/api/v2/workspaces/:workspace_id/current-state-version
```

**Response (200):**

```json
{
  "data": {
    "id": "sv-xxx",
    "type": "state-versions",
    "attributes": {
      "serial": 42,
      "status": "finalized",
      "hosted-state-download-url": "/tfc/api/v2/state-versions/sv-xxx/download",
      "terraform-version": "1.7.0",
      "resources-processed": true,
      "created-at": "2024-03-06T12:00:00Z"
    }
  }
}
```

**Response (404):** Workspace has no state yet.

#### Download State

```http
GET /tfc/api/v2/state-versions/:state_version_id/download
```

**Response (302):** Redirect to time-limited S3 presigned URL.

Or **Response (200):** Stream state bytes directly (simpler, avoids CORS issues).

#### List State Versions

```http
GET /tfc/api/v2/state-versions?filter[workspace][name]=ws-name&filter[organization][name]=org-name
```

Returns paginated list of all state versions for a workspace.

---

## Workspace Lifecycle

### Auto-Creation

Workspaces are created automatically when Yaffle processes webhook events:

1. PR opened/synchronized triggers webhook
2. Yaffle parses `yaffle.toml` for workspace paths
3. For each workspace path, Yaffle creates a workspace if not exists:
   ```
   name: pr-{pr_number}-{workspace_path_slug}
   environment: preview
   pr_number: {pr_number}
   ```

### Locking Semantics

Locking is advisory and enforced by Yaffle (not S3/DynamoDB):

- Lock stored in `workspaces.locked`, `locked_by`, `locked_at`, `lock_reason`
- Acquired atomically via `SELECT ... FOR UPDATE`
- Lock owner format:
  - `user:{user_id}` - CLI user locked manually
  - `run:{run_id}` - Automated run holds lock

**Lock flow for automated runs:**

```
webhook received
  → create/find workspace
  → lock workspace (locked_by = "run:{run_id}")
  → start terraform run
  → run completes
  → unlock workspace
```

### Cleanup (Preview Environments)

When a PR is closed or merged:

1. Lock workspace
2. Run `terraform destroy`
3. Set workspace status to `archived`
4. State versions remain in S3 (cleaned up by lifecycle policy after 7 days)

Production workspaces are never automatically destroyed.

---

## Runner Integration

### Current State (To Be Replaced)

The current `local-runner.ts` generates `backend_override.tf` with S3 backend:

```hcl
terraform {
  backend "s3" {
    bucket         = "yaffle-state"
    key            = "owner/repo/previews/pr-42/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "yaffle-locks"
    encrypt        = true
  }
}
```

### New Approach

The runner will generate a cloud backend configuration using `YAFFLE_TFC_API_HOST`:

```hcl
# Generated by Yaffle
# YAFFLE_TFC_API_HOST=yaffle.dev (or localhost:3000, pr-123.yaffle.dev, etc.)
terraform {
  cloud {
    hostname     = "${YAFFLE_TFC_API_HOST}"
    organization = "acme"

    workspaces {
      name = "pr-42-control-plane-infra"
    }
  }
}
```

And inject credentials (token env var name derived from hostname):

```bash
export YAFFLE_TFC_API_HOST="yaffle.dev"
export TF_TOKEN_yaffle_dev="<run-jwt>"

# Or for local dev:
export YAFFLE_TFC_API_HOST="localhost:3000"
export TF_TOKEN_localhost_3000="<run-jwt>"
```

This makes Terraform talk to Yaffle's API for all state operations.

---

## S3 Storage

### Bucket Structure

State files stored in the bucket specified by `YAFFLE_TFC_STATE_S3_BUCKET`:

```
{workspace_id}/v{serial}.tfstate
{workspace_id}/v{serial}.tfstate.json   # JSON format (TF 1.3+)
```

Example:

```
019d5b7a-1234-7def-8abc-000000000001/v1.tfstate
019d5b7a-1234-7def-8abc-000000000001/v2.tfstate
019d5b7a-1234-7def-8abc-000000000001/v3.tfstate
```

### Environment Variables

| Variable                     | Description                 | Example             |
| ---------------------------- | --------------------------- | ------------------- |
| `YAFFLE_TFC_STATE_S3_BUCKET` | S3 bucket for state storage | `yaffle-state-prod` |
| `YAFFLE_TFC_STATE_S3_REGION` | AWS region for the bucket   | `us-east-1`         |

### Lifecycle Policy

Configure lifecycle rules on the S3 bucket:

- Production: Non-current versions expire after 90 days
- Preview: Non-current versions expire after 7 days

### Presigned URLs

For downloads, generate S3 presigned GET URLs:

- Expiry: 5 minutes
- Returned via redirect or in API response

For uploads, Yaffle proxies the upload (validates MD5, writes to S3).

---

## Implementation Phases

### Phase 1: Database Schema

- Add migrations for `workspaces`, `state_versions`, `api_tokens`
- Add Drizzle schema definitions
- **Effort**: Small

### Phase 2: Service Discovery & OAuth

- `GET /.well-known/terraform.json`
- OAuth endpoints for `terraform login`
- API token issuance and storage
- **Effort**: Medium

### Phase 3: Workspace API

- CRUD endpoints for workspaces
- Lock/unlock/force-unlock
- JSON:API response formatting
- **Effort**: Medium

### Phase 4: State Versions API

- Create state version (two-phase upload)
- Upload state content
- Download state (presigned URLs)
- Get current state version
- List state versions
- **Effort**: Large

### Phase 5: Webhook Integration

- Auto-create workspaces from webhook events
- Lock workspace before runs
- Unlock workspace after runs
- Generate run JWTs
- Update runner to use cloud backend
- **Effort**: Medium

### Phase 6: Cleanup Lifecycle

- Archive workspaces on PR close
- Destroy preview infrastructure
- State version cleanup
- **Effort**: Small

---

## File Structure

### New Files

```
src/
├── routes/
│   ├── well-known.ts              # /.well-known/terraform.json
│   ├── oauth-cli.ts               # OAuth flow for terraform login
│   └── tfc/
│       ├── index.ts               # TFC API router (/api/v2/*)
│       ├── workspaces.ts          # Workspace endpoints
│       └── state-versions.ts      # State version endpoints
├── lib/
│   ├── workspace-service.ts       # Workspace business logic
│   ├── state-version-service.ts   # State version business logic
│   ├── s3-state.ts                # S3 operations for state
│   └── run-token.ts               # JWT generation for runs
├── middleware/
│   └── tfc-auth.ts                # Bearer token auth
└── db/queries/
    ├── workspaces.ts              # Workspace queries
    ├── state-versions.ts          # State version queries
    └── api-tokens.ts              # API token queries

drizzle/
├── 0005_add_workspaces.sql
├── 0006_add_state_versions.sql
└── 0007_add_api_tokens.sql
```

### Modified Files

```
src/
├── index.ts                       # Add new routes
├── db/schema.ts                   # Add new tables
├── lib/
│   ├── webhook-handler.ts         # Integrate workspace mgmt
│   └── local-runner.ts            # Use cloud backend
```

### Deprecated Files

```
src/lib/state.ts                   # To be removed after migration
```

---

## Security Considerations

### Token Security

- **User tokens**: Bcrypt-hashed in database, never logged
- **Run tokens**: JWTs with short TTL, signed with server secret
- **No token in URLs**: Always use Authorization header

### Workspace Isolation

- Tokens scoped to specific workspace (run tokens)
- User tokens scoped to org membership
- Cross-org access impossible

### State Sensitivity

- State may contain sensitive values
- Outputs extracted with sensitive values redacted
- S3 encryption enabled (AES-256)
- Presigned URLs short-lived (5 min)

### Audit Trail

- All state operations logged with:
  - User/run identity
  - Workspace ID
  - Timestamp
  - Operation type
  - Source IP

---

## Local Development

No special configuration needed. The service discovery endpoint uses relative
URLs, so it works on any hostname:

```json
{
  "tfe.v2": "/tfc/api/v2/",
  "login.v1": {
    "authz": "/tfc/oauth/authorize",
    "token": "/tfc/oauth/token",
    "ports": [10000, 10010]
  }
}
```

To test locally:

```bash
# Start the control plane
bun run dev:control-plane

# Point terraform at local instance
terraform login localhost:3000

# Or set token directly (underscore replaces special chars in hostname)
export TF_TOKEN_localhost_3000="<dev-token>"
```

For automated runs, the runner uses the `YAFFLE_TFC_API_HOST` environment variable
to determine where to point Terraform. This allows flexibility across environments:

- Local dev: `localhost:3000`
- Preview environments: `pr-123.yaffle.dev`
- Production: `yaffle.dev`

---

## Future Enhancements

### State Encryption (BYOK)

**Status:** Post-MVP, enterprise feature

S3 already encrypts at rest with AWS-managed keys. Customer-managed keys (BYOK)
is an enterprise upsell. No schema/API changes needed - just add key ARN to
org or workspace config later.

### State Diffing in PR Comments

**Status:** Not planned

Low value compared to plan output, and tends to be noisy. Easy to add later if
users request it.

### Remote State Data Sources & State Inheritance

**Status:** Requires separate design doc (not blocking MVP)

`terraform_remote_state` should work within a Yaffle org:

- Workspaces within the same org can reference each other
- Preview workspaces can read production state (parent → PR inheritance)
- External state access is out of scope

This is core to Yaffle's preview ergonomics and needs dedicated design work.

**MVP approach:** Preview workspaces start with empty state. State inheritance
from production → preview is a follow-up feature. Phases 1-5 can ship without
resolving the inheritance semantics.

### Workspace Variables

**Status:** MVP, config-driven

Variables are stored in `yaffle.toml`, not in the UI. The public syntax is documented at
<https://yaffle.dev/docs/reference/configuration/#variable-templating>.

Benefits:

- Variables reviewable/auditable in PRs
- Preview and named environments can diverge through templated values
- No UI needed for MVP
- Fits Yaffle's PR-centric model

---

## References

- [TFC State Versions API](https://developer.hashicorp.com/terraform/cloud-docs/api-docs/state-versions)
- [TFC Workspaces API](https://developer.hashicorp.com/terraform/cloud-docs/api-docs/workspaces)
- [Terraform Login Protocol](https://developer.hashicorp.com/terraform/internals/login-protocol)
- [Terraform Service Discovery](https://developer.hashicorp.com/terraform/internals/remote-service-discovery)
- [OTF (Open Terraform)](https://github.com/leg100/otf) - Open source TFC implementation
